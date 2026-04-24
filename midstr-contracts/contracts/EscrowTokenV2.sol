// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract EscrowTokenV2 is ReentrancyGuard {
    IERC20 public immutable token;
    address public immutable treasury;
    address public immutable aiResolver;

    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    uint256 public constant BPS = 10_000;
    uint256 public constant RESOLUTION_WINDOW = 7 days;

    // Normal settlement: 98% winner, 1% treasury, 1% burn
    uint256 public constant NORMAL_TREASURY_BPS = 100;
    uint256 public constant NORMAL_BURN_BPS = 100;

    // Timeout settlement on remaining half-pot:
    // 10% caller, 20% treasury, 20% burn, dust -> treasury
    uint256 public constant TIMEOUT_CALLER_BPS = 1000;
    uint256 public constant TIMEOUT_TREASURY_BPS = 2000;
    uint256 public constant TIMEOUT_BURN_BPS = 2000;

    enum ResolutionType {
        VERIFIABLE,
        AMBIGUOUS,
        MANUAL_ONLY
    }

    enum BetStatus {
        NONE,
        CREATED,
        LIVE,
        CLOSED,
        WAITING_RESULT,
        RESOLUTION_WINDOW_OPEN,
        DISPUTED,
        FINALISED,
        CANCELLED
    }

    struct Bet {
        // Bound wallets
        address creatorWallet;
        address takerWallet;

        // Amounts
        uint256 stake; // stake per side

        // Configuration
        ResolutionType resolutionType;
        BetStatus status;
        uint64 closeTimeUtc;
        uint64 resultExpectedByUtc; // 0 for VERIFIABLE if unused

        // Resolution state
        uint64 proposalTimeUtc;     // VERIFIABLE path
        uint64 finalisedAtUtc;
        uint8 winnerSide;           // 0 none, 1 creator, 2 taker, 3 timeout path

        // Funding/claim flags
        bool creatorFunded;
        bool takerFunded;
        bool claimed;
    }

    uint256 public nextBetId;
    mapping(uint256 => Bet) public bets;

    event BetCreated(
        uint256 indexed betId,
        address indexed creatorWallet,
        uint256 stake,
        ResolutionType resolutionType,
        uint64 closeTimeUtc,
        uint64 resultExpectedByUtc
    );

    event CreatorFunded(uint256 indexed betId, address indexed creatorWallet, uint256 amount);
    event TakerJoined(uint256 indexed betId, address indexed takerWallet, uint256 amount);
    event BetCancelled(uint256 indexed betId);
    event StatusRefreshed(uint256 indexed betId, BetStatus newStatus);

    event ClaimWinSubmitted(uint256 indexed betId, address indexed caller, uint8 winnerSide);
    event ConcedeSubmitted(uint256 indexed betId, address indexed caller, uint8 winnerSide);

    event VerifiableResultProposed(
        uint256 indexed betId,
        uint8 winnerSide,
        uint64 proposalTimeUtc
    );

    event BetDisputed(uint256 indexed betId, address indexed caller);

    event PayoutClaimed(
        uint256 indexed betId,
        address indexed winnerWallet,
        uint256 winnerAmount,
        uint256 treasuryAmount,
        uint256 burnAmount
    );

    event TimeoutResolved(
        uint256 indexed betId,
        address indexed caller,
        uint256 creatorRefund,
        uint256 takerRefund,
        uint256 callerAmount,
        uint256 treasuryAmount,
        uint256 burnAmount
    );

    error ZeroAddress();
    error InvalidStake();
    error InvalidTime();
    error BetNotFound();
    error InvalidState();
    error BetClosed();
    error TooEarly();
    error ResolutionWindowNotOpen();
    error ResolutionWindowExpired();
    error AlreadyFunded();
    error AlreadyClaimed();
    error AlreadyHasTaker();
    error NotCreatorWallet();
    error NotParticipant();
    error NotBoundWinnerWallet();
    error CannotJoinOwnBet();
    error NotAIResolver();
    error TransferFailed();
    error NoTaker();
    error NotFinalised();

    modifier betExists(uint256 betId) {
        if (betId >= nextBetId) revert BetNotFound();
        _;
    }

    modifier onlyAIResolver() {
        if (msg.sender != aiResolver) revert NotAIResolver();
        _;
    }

    constructor(address _token, address _treasury, address _aiResolver) {
        if (_token == address(0) || _treasury == address(0) || _aiResolver == address(0)) {
            revert ZeroAddress();
        }

        token = IERC20(_token);
        treasury = _treasury;
        aiResolver = _aiResolver;
    }

    function createBet(
        uint256 stake,
        ResolutionType resolutionType,
        uint64 closeTimeUtc,
        uint64 resultExpectedByUtc
    ) external returns (uint256 betId) {
        if (stake == 0) revert InvalidStake();
        if (closeTimeUtc <= block.timestamp) revert InvalidTime();

        if (resolutionType == ResolutionType.VERIFIABLE) {
            // VERIFIABLE does not require resultExpectedByUtc
            if (resultExpectedByUtc != 0 && resultExpectedByUtc < closeTimeUtc) {
                revert InvalidTime();
            }
        } else {
            // AMBIGUOUS / MANUAL_ONLY require explicit future result time after close
            if (resultExpectedByUtc <= closeTimeUtc) revert InvalidTime();
        }

        betId = nextBetId;

        bets[betId] = Bet({
            creatorWallet: msg.sender,
            takerWallet: address(0),
            stake: stake,
            resolutionType: resolutionType,
            status: BetStatus.CREATED,
            closeTimeUtc: closeTimeUtc,
            resultExpectedByUtc: resultExpectedByUtc,
            proposalTimeUtc: 0,
            finalisedAtUtc: 0,
            winnerSide: 0,
            creatorFunded: false,
            takerFunded: false,
            claimed: false
        });

        nextBetId++;

        emit BetCreated(
            betId,
            msg.sender,
            stake,
            resolutionType,
            closeTimeUtc,
            resultExpectedByUtc
        );
    }

    function fundCreator(uint256 betId) external betExists(betId) {
        Bet storage b = bets[betId];

        if (msg.sender != b.creatorWallet) revert NotCreatorWallet();
        if (b.creatorFunded) revert AlreadyFunded();
        if (b.status != BetStatus.CREATED) revert InvalidState();
        if (block.timestamp >= b.closeTimeUtc) revert BetClosed();

        b.creatorFunded = true;

        _pull(msg.sender, b.stake);

        emit CreatorFunded(betId, msg.sender, b.stake);
    }

    function joinAsTaker(uint256 betId) external betExists(betId) {
        Bet storage b = bets[betId];

        if (!b.creatorFunded) revert InvalidState();
        if (b.takerFunded || b.takerWallet != address(0)) revert AlreadyHasTaker();
        if (block.timestamp >= b.closeTimeUtc) revert BetClosed();
        if (msg.sender == b.creatorWallet) revert CannotJoinOwnBet();
        if (b.status != BetStatus.CREATED && b.status != BetStatus.LIVE) revert InvalidState();

        b.takerWallet = msg.sender;
        b.takerFunded = true;
        b.status = BetStatus.LIVE;

        _pull(msg.sender, b.stake);

        emit TakerJoined(betId, msg.sender, b.stake);
    }

    function cancelBet(uint256 betId) external betExists(betId) nonReentrant {
        Bet storage b = bets[betId];

        if (msg.sender != b.creatorWallet) revert NotCreatorWallet();
        if (b.status != BetStatus.CREATED) revert InvalidState();
        if (block.timestamp >= b.closeTimeUtc) revert BetClosed();
        if (b.takerFunded || b.takerWallet != address(0)) revert InvalidState();

        b.status = BetStatus.CANCELLED;

        if (b.creatorFunded) {
            b.creatorFunded = false;
            _push(b.creatorWallet, b.stake);
        }

        emit BetCancelled(betId);
    }

    function refreshStatus(uint256 betId) public betExists(betId) {
        Bet storage b = bets[betId];
        BetStatus oldStatus = b.status;

        if (
            b.status == BetStatus.CANCELLED ||
            b.status == BetStatus.FINALISED ||
            b.status == BetStatus.DISPUTED
        ) {
            return;
        }

        if (b.status == BetStatus.CREATED && block.timestamp >= b.closeTimeUtc) {
            b.status = BetStatus.CLOSED;
        }

        if (b.status == BetStatus.LIVE && block.timestamp >= b.closeTimeUtc) {
            b.status = BetStatus.CLOSED;
        }

        if (
            b.status == BetStatus.CLOSED &&
            b.resolutionType != ResolutionType.VERIFIABLE &&
            block.timestamp < b.resultExpectedByUtc
        ) {
            b.status = BetStatus.WAITING_RESULT;
        }

        if (
            (b.status == BetStatus.CLOSED || b.status == BetStatus.WAITING_RESULT) &&
            b.resolutionType != ResolutionType.VERIFIABLE &&
            block.timestamp >= b.resultExpectedByUtc
        ) {
            b.status = BetStatus.RESOLUTION_WINDOW_OPEN;
        }

        if (
            b.resolutionType == ResolutionType.VERIFIABLE &&
            b.proposalTimeUtc != 0 &&
            b.status != BetStatus.FINALISED &&
            b.status != BetStatus.DISPUTED
        ) {
            b.status = BetStatus.RESOLUTION_WINDOW_OPEN;
        }

        if (b.status != oldStatus) {
            emit StatusRefreshed(betId, b.status);
        }
    }

    function claimWin(uint256 betId) external betExists(betId) {
        Bet storage b = bets[betId];
        refreshStatus(betId);

        if (!_isParticipant(b, msg.sender)) revert NotParticipant();
        if (!b.takerFunded) revert NoTaker();

        if (b.resolutionType == ResolutionType.VERIFIABLE) revert InvalidState();
        if (block.timestamp < b.resultExpectedByUtc) revert TooEarly();
        if (b.status != BetStatus.RESOLUTION_WINDOW_OPEN) revert ResolutionWindowNotOpen();
        if (block.timestamp >= uint256(b.resultExpectedByUtc) + RESOLUTION_WINDOW) {
            revert ResolutionWindowExpired();
        }

        b.winnerSide = msg.sender == b.creatorWallet ? 1 : 2;
        b.status = BetStatus.FINALISED;
        b.finalisedAtUtc = uint64(block.timestamp);

        emit ClaimWinSubmitted(betId, msg.sender, b.winnerSide);
    }

    function concede(uint256 betId) external betExists(betId) {
        Bet storage b = bets[betId];
        refreshStatus(betId);

        if (!_isParticipant(b, msg.sender)) revert NotParticipant();
        if (!b.takerFunded) revert NoTaker();

        if (b.resolutionType == ResolutionType.VERIFIABLE) revert InvalidState();
        if (block.timestamp < b.resultExpectedByUtc) revert TooEarly();
        if (b.status != BetStatus.RESOLUTION_WINDOW_OPEN) revert ResolutionWindowNotOpen();
        if (block.timestamp >= uint256(b.resultExpectedByUtc) + RESOLUTION_WINDOW) {
            revert ResolutionWindowExpired();
        }

        b.winnerSide = msg.sender == b.creatorWallet ? 2 : 1;
        b.status = BetStatus.FINALISED;
        b.finalisedAtUtc = uint64(block.timestamp);

        emit ConcedeSubmitted(betId, msg.sender, b.winnerSide);
    }

    function proposeResultVerifiable(
        uint256 betId,
        uint8 winnerSide
    ) external betExists(betId) onlyAIResolver {
        Bet storage b = bets[betId];
        refreshStatus(betId);

        if (!b.takerFunded) revert NoTaker();
        if (b.resolutionType != ResolutionType.VERIFIABLE) revert InvalidState();
        if (winnerSide != 1 && winnerSide != 2) revert InvalidState();
        if (block.timestamp < b.closeTimeUtc) revert TooEarly();
        if (
            b.status != BetStatus.CLOSED &&
            b.status != BetStatus.LIVE &&
            b.status != BetStatus.CREATED
        ) {
            // allow CLOSED path cleanly; LIVE/CREATED can be refreshed to CLOSED if closeTime passed
            if (b.status != BetStatus.RESOLUTION_WINDOW_OPEN) revert InvalidState();
        }

        b.winnerSide = winnerSide;
        b.proposalTimeUtc = uint64(block.timestamp);
        b.status = BetStatus.RESOLUTION_WINDOW_OPEN;

        emit VerifiableResultProposed(betId, winnerSide, b.proposalTimeUtc);
    }

    function dispute(uint256 betId) external betExists(betId) {
        Bet storage b = bets[betId];
        refreshStatus(betId);

        if (!_isParticipant(b, msg.sender)) revert NotParticipant();
        if (!b.takerFunded) revert NoTaker();
        if (b.status != BetStatus.RESOLUTION_WINDOW_OPEN) revert ResolutionWindowNotOpen();

        uint256 windowStart = _windowStart(b);
        if (windowStart == 0) revert ResolutionWindowNotOpen();
        if (block.timestamp >= windowStart + RESOLUTION_WINDOW) revert ResolutionWindowExpired();

        // Bond mechanics are not implemented yet.
        // For now, dispute simply freezes settlement into DISPUTED state.
        b.status = BetStatus.DISPUTED;

        emit BetDisputed(betId, msg.sender);
    }

    function finaliseDisputedBet(
        uint256 betId,
        uint8 winnerSide
    ) external betExists(betId) onlyAIResolver {
        Bet storage b = bets[betId];

        if (b.status != BetStatus.DISPUTED) revert InvalidState();
        if (winnerSide != 1 && winnerSide != 2) revert InvalidState();

        b.winnerSide = winnerSide;
        b.status = BetStatus.FINALISED;
        b.finalisedAtUtc = uint64(block.timestamp);
    }

    function claimPayout(uint256 betId) external betExists(betId) nonReentrant {
        Bet storage b = bets[betId];

        if (b.status != BetStatus.FINALISED) revert NotFinalised();
        if (b.claimed) revert AlreadyClaimed();
        if (b.winnerSide != 1 && b.winnerSide != 2) revert InvalidState();

        address winnerWallet = b.winnerSide == 1 ? b.creatorWallet : b.takerWallet;

        if (msg.sender != winnerWallet) revert NotBoundWinnerWallet();

        b.claimed = true;

        uint256 pot = b.stake * 2;
        uint256 treasuryAmt = (pot * NORMAL_TREASURY_BPS) / BPS;
        uint256 burnAmt = (pot * NORMAL_BURN_BPS) / BPS;
        uint256 winnerAmt = pot - treasuryAmt - burnAmt;

        _push(winnerWallet, winnerAmt);
        _push(treasury, treasuryAmt);
        _push(BURN, burnAmt);

        emit PayoutClaimed(betId, winnerWallet, winnerAmt, treasuryAmt, burnAmt);
    }

    function timeoutResolve(uint256 betId) external betExists(betId) nonReentrant {
        Bet storage b = bets[betId];
        refreshStatus(betId);

        if (!b.takerFunded) revert NoTaker();
        if (b.claimed) revert AlreadyClaimed();
        if (b.status == BetStatus.FINALISED || b.status == BetStatus.DISPUTED) revert InvalidState();

        uint256 windowStart = _windowStart(b);
        if (windowStart == 0) revert ResolutionWindowNotOpen();
        if (block.timestamp < windowStart + RESOLUTION_WINDOW) revert ResolutionWindowNotOpen();

        b.claimed = true;
        b.status = BetStatus.FINALISED;
        b.finalisedAtUtc = uint64(block.timestamp);
        b.winnerSide = 3;

        // Spec:
        // 50% of each participant's stake refunded
        // Remaining 50% of total pot split: 10% caller, 20% treasury, 20% burn
        //
        // Total pot = 2 * stake
        // Half refunded total = stake
        // Remaining half = stake

        uint256 creatorRefund = b.stake / 2;
        uint256 takerRefund = b.stake / 2;

        uint256 remaining = b.stake;
        uint256 callerAmt = (remaining * TIMEOUT_CALLER_BPS) / BPS;
        uint256 treasuryAmt = (remaining * TIMEOUT_TREASURY_BPS) / BPS;
        uint256 burnAmt = (remaining * TIMEOUT_BURN_BPS) / BPS;
        uint256 dust = remaining - callerAmt - treasuryAmt - burnAmt;

        _push(b.creatorWallet, creatorRefund);
        _push(b.takerWallet, takerRefund);
        _push(msg.sender, callerAmt);
        _push(treasury, treasuryAmt + dust);
        _push(BURN, burnAmt);

        emit TimeoutResolved(
            betId,
            msg.sender,
            creatorRefund,
            takerRefund,
            callerAmt,
            treasuryAmt + dust,
            burnAmt
        );
    }

    function getWindowStart(uint256 betId) external view betExists(betId) returns (uint256) {
        return _windowStart(bets[betId]);
    }

    function canJoin(uint256 betId) external view betExists(betId) returns (bool) {
        Bet storage b = bets[betId];
        return
            b.creatorFunded &&
            !b.takerFunded &&
            block.timestamp < b.closeTimeUtc &&
            (b.status == BetStatus.CREATED || b.status == BetStatus.LIVE);
    }

    function canClaimOrConcede(uint256 betId) external view betExists(betId) returns (bool) {
        Bet storage b = bets[betId];
        if (b.resolutionType == ResolutionType.VERIFIABLE) return false;
        if (!b.takerFunded) return false;
        if (block.timestamp < b.resultExpectedByUtc) return false;
        if (block.timestamp >= uint256(b.resultExpectedByUtc) + RESOLUTION_WINDOW) return false;

        return
            b.status == BetStatus.RESOLUTION_WINDOW_OPEN ||
            (
                (b.status == BetStatus.CLOSED || b.status == BetStatus.WAITING_RESULT) &&
                block.timestamp >= b.resultExpectedByUtc
            );
    }

    function _windowStart(Bet storage b) internal view returns (uint256) {
        if (b.resolutionType == ResolutionType.VERIFIABLE) {
            return b.proposalTimeUtc;
        }
        return b.resultExpectedByUtc;
    }

    function _isParticipant(Bet storage b, address user) internal view returns (bool) {
        return user == b.creatorWallet || user == b.takerWallet;
    }

    function _pull(address from, uint256 amount) internal {
        bool ok = token.transferFrom(from, address(this), amount);
        if (!ok) revert TransferFailed();
    }

    function _push(address to, uint256 amount) internal {
        bool ok = token.transfer(to, amount);
        if (!ok) revert TransferFailed();
    }
}