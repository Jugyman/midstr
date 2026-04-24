// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * EscrowTokenV3
 *
 * Phase 6 resolution + settlement contract.
 *
 * Core rules:
 * - ERC20 MIDSTR only.
 * - 1v1 fixed stake bets.
 * - Creator funds first, taker joins second.
 * - Backend/AI coordinates, but contract is financial truth.
 * - Manual/Ambiguous resolution window starts at Result Expected By.
 * - Verifiable resolution window starts when arbiterResolver proposes result.
 * - claimWin() sets proposed winner for manual/ambiguous bets.
 * - concedeAndSettle() lets proposed loser settle immediately and earn caller reward.
 * - challengeResult() posts bond and moves bet to DISPUTED.
 * - arbiterResolver finalises disputed outcome.
 * - settle() is permissionless after window expiry or dispute finalisation.
 * - timeoutResolve() handles no-action manual/ambiguous bets.
 */
contract EscrowTokenV3 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public immutable treasury;
    address public immutable arbiterResolver;

    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    uint256 public constant BPS = 10_000;
    uint256 public constant RESOLUTION_WINDOW = 7 days;

    // Phase 6 locked values
    uint256 public constant CALLER_REWARD_BPS = 100; // 1% of total pot
    uint256 public constant CHALLENGE_BOND_BPS = 5_000; // 50% of one side stake

    // Wrong challenge bond split
    uint256 public constant WRONG_BOND_TREASURY_BPS = 5_000; // 50% of bond
    uint256 public constant WRONG_BOND_BURN_BPS = 5_000; // 50% of bond

    // Timeout/no-action settlement, measured against total pot.
    // Creator refund 25% pot, taker refund 25% pot, caller 10%, treasury 20%, burn 20%.
    uint256 public constant TIMEOUT_CREATOR_REFUND_BPS = 2_500;
    uint256 public constant TIMEOUT_TAKER_REFUND_BPS = 2_500;
    uint256 public constant TIMEOUT_CALLER_BPS = 1_000;
    uint256 public constant TIMEOUT_TREASURY_BPS = 2_000;
    uint256 public constant TIMEOUT_BURN_BPS = 2_000;

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
        SETTLED,
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
        uint64 resultExpectedByUtc; // required for AMBIGUOUS / MANUAL_ONLY

        // Resolution state
        uint64 proposalTimeUtc; // verifiable proposal time OR manual claim time
        uint64 finalisedAtUtc;
        uint8 proposedWinnerSide; // 0 none, 1 creator, 2 taker
        uint8 finalWinnerSide; // 0 none, 1 creator, 2 taker

        // Dispute state
        address challengerWallet;
        uint256 challengeBond;
        bool challengeCorrect;

        // Funding/final flags
        bool creatorFunded;
        bool takerFunded;
        bool settled;
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

    event ResultProposed(
        uint256 indexed betId,
        address indexed proposer,
        uint8 proposedWinnerSide,
        uint64 proposalTimeUtc
    );

    event BetChallenged(
        uint256 indexed betId,
        address indexed challenger,
        uint256 bondAmount
    );

    event DisputeFinalised(
        uint256 indexed betId,
        address indexed resolver,
        uint8 finalWinnerSide,
        bool challengeCorrect
    );

    event BetSettled(
        uint256 indexed betId,
        address indexed caller,
        address indexed winnerWallet,
        uint256 winnerAmount,
        uint256 callerReward
    );

    event BetSettledWithWrongChallenge(
        uint256 indexed betId,
        address indexed caller,
        address indexed winnerWallet,
        uint256 winnerAmount,
        uint256 callerReward,
        uint256 treasuryBondAmount,
        uint256 burnBondAmount
    );

    event BetSettledWithCorrectChallenge(
        uint256 indexed betId,
        address indexed caller,
        address indexed winnerWallet,
        address challenger,
        uint256 winnerAmount,
        uint256 callerReward,
        uint256 bondReturned
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
    error ResolutionWindowStillOpen();
    error AlreadyFunded();
    error AlreadySettled();
    error AlreadyHasTaker();
    error AlreadyProposed();
    error NotCreatorWallet();
    error NotParticipant();
    error CannotJoinOwnBet();
    error NotArbiterResolver();
    error NoTaker();
    error NoProposedWinner();
    error NotProposedLoser();
    error InvalidWinnerSide();
    error NotDisputed();
    error NotFinalised();

    modifier betExists(uint256 betId) {
        if (betId >= nextBetId) revert BetNotFound();
        _;
    }

    modifier onlyArbiterResolver() {
        if (msg.sender != arbiterResolver) revert NotArbiterResolver();
        _;
    }

    constructor(address _token, address _treasury, address _arbiterResolver) {
        if (_token == address(0) || _treasury == address(0) || _arbiterResolver == address(0)) {
            revert ZeroAddress();
        }

        token = IERC20(_token);
        treasury = _treasury;
        arbiterResolver = _arbiterResolver;
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
            if (resultExpectedByUtc != 0 && resultExpectedByUtc < closeTimeUtc) {
                revert InvalidTime();
            }
        } else {
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
            proposedWinnerSide: 0,
            finalWinnerSide: 0,
            challengerWallet: address(0),
            challengeBond: 0,
            challengeCorrect: false,
            creatorFunded: false,
            takerFunded: false,
            settled: false
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

        token.safeTransferFrom(msg.sender, address(this), b.stake);

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

        token.safeTransferFrom(msg.sender, address(this), b.stake);

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
            token.safeTransfer(b.creatorWallet, b.stake);
        }

        emit BetCancelled(betId);
    }

    function refreshStatus(uint256 betId) public betExists(betId) {
        Bet storage b = bets[betId];
        BetStatus oldStatus = b.status;

        if (
            b.status == BetStatus.CANCELLED ||
            b.status == BetStatus.DISPUTED ||
            b.status == BetStatus.FINALISED ||
            b.status == BetStatus.SETTLED
        ) {
            return;
        }

        if (
            (b.status == BetStatus.CREATED || b.status == BetStatus.LIVE) &&
            block.timestamp >= b.closeTimeUtc
        ) {
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

        if (b.status != oldStatus) {
            emit StatusRefreshed(betId, b.status);
        }
    }

    /**
     * Verifiable bets:
     * arbiterResolver proposes result after the bet is closed.
     * This starts the 7-day challenge window.
     */
    function proposeResultVerifiable(
        uint256 betId,
        uint8 winnerSide
    ) external betExists(betId) onlyArbiterResolver {
        Bet storage b = bets[betId];
        refreshStatus(betId);

        if (!b.takerFunded) revert NoTaker();
        if (b.resolutionType != ResolutionType.VERIFIABLE) revert InvalidState();
        if (!_validWinnerSide(winnerSide)) revert InvalidWinnerSide();
        if (block.timestamp < b.closeTimeUtc) revert TooEarly();
        if (b.proposedWinnerSide != 0) revert AlreadyProposed();
        if (b.status != BetStatus.CLOSED && b.status != BetStatus.RESOLUTION_WINDOW_OPEN) {
            revert InvalidState();
        }

        b.proposedWinnerSide = winnerSide;
        b.proposalTimeUtc = uint64(block.timestamp);
        b.status = BetStatus.RESOLUTION_WINDOW_OPEN;

        emit ResultProposed(betId, msg.sender, winnerSide, b.proposalTimeUtc);
    }

    /**
     * Manual/Ambiguous bets:
     * claimWin sets a proposed winner during the existing Result Expected By window.
     * It does not start the window.
     */
    function claimWin(uint256 betId) external betExists(betId) {
        Bet storage b = bets[betId];
        refreshStatus(betId);

        if (!_isParticipant(b, msg.sender)) revert NotParticipant();
        if (!b.takerFunded) revert NoTaker();
        if (b.resolutionType == ResolutionType.VERIFIABLE) revert InvalidState();
        if (b.status != BetStatus.RESOLUTION_WINDOW_OPEN) revert ResolutionWindowNotOpen();
        if (!_insideWindow(b)) revert ResolutionWindowNotOpen();
        if (b.proposedWinnerSide != 0) revert AlreadyProposed();

        uint8 winnerSide = msg.sender == b.creatorWallet ? 1 : 2;

        b.proposedWinnerSide = winnerSide;
        b.proposalTimeUtc = uint64(block.timestamp);

        emit ResultProposed(betId, msg.sender, winnerSide, b.proposalTimeUtc);
    }

    /**
     * Proposed loser agrees with the result.
     * Settlement happens immediately and the conceding loser earns the caller reward.
     */
    function concedeAndSettle(uint256 betId) external betExists(betId) nonReentrant {
        Bet storage b = bets[betId];
        refreshStatus(betId);

        if (!_isParticipant(b, msg.sender)) revert NotParticipant();
        if (!b.takerFunded) revert NoTaker();
        if (b.status != BetStatus.RESOLUTION_WINDOW_OPEN) revert ResolutionWindowNotOpen();
        if (!_insideWindow(b)) revert ResolutionWindowNotOpen();
        if (b.proposedWinnerSide == 0) revert NoProposedWinner();

        address proposedLoser = _sideWallet(b, _oppositeSide(b.proposedWinnerSide));
        if (msg.sender != proposedLoser) revert NotProposedLoser();

        b.finalWinnerSide = b.proposedWinnerSide;
        b.finalisedAtUtc = uint64(block.timestamp);

        _settleWinnerOnly(betId, b, msg.sender);
    }

    /**
     * Challenge the proposed result.
     * Challenger posts bond and bet enters DISPUTED.
     */
    function challengeResult(uint256 betId) external betExists(betId) nonReentrant {
        Bet storage b = bets[betId];
        refreshStatus(betId);

        if (!_isParticipant(b, msg.sender)) revert NotParticipant();
        if (!b.takerFunded) revert NoTaker();
        if (b.status != BetStatus.RESOLUTION_WINDOW_OPEN) revert ResolutionWindowNotOpen();
        if (!_insideWindow(b)) revert ResolutionWindowNotOpen();
        if (b.proposedWinnerSide == 0) revert NoProposedWinner();

        address proposedLoser = _sideWallet(b, _oppositeSide(b.proposedWinnerSide));
        if (msg.sender != proposedLoser) revert NotProposedLoser();

        uint256 bondAmount = challengeBondAmount(betId);

        b.challengerWallet = msg.sender;
        b.challengeBond = bondAmount;
        b.status = BetStatus.DISPUTED;

        token.safeTransferFrom(msg.sender, address(this), bondAmount);

        emit BetChallenged(betId, msg.sender, bondAmount);
    }

    /**
     * The arbiterResolver writes the disputed outcome on-chain.
     * This does not pay anyone. Anyone can call settle() afterwards.
     */
    function finaliseDispute(
        uint256 betId,
        uint8 finalWinnerSide,
        bool challengeCorrect
    ) external betExists(betId) onlyArbiterResolver {
        Bet storage b = bets[betId];

        if (b.status != BetStatus.DISPUTED) revert NotDisputed();
        if (!_validWinnerSide(finalWinnerSide)) revert InvalidWinnerSide();
        if (b.challengerWallet == address(0) || b.challengeBond == 0) revert InvalidState();

        if (challengeCorrect) {
            if (finalWinnerSide == b.proposedWinnerSide) revert InvalidState();
        } else {
            if (finalWinnerSide != b.proposedWinnerSide) revert InvalidState();
        }

        b.finalWinnerSide = finalWinnerSide;
        b.challengeCorrect = challengeCorrect;
        b.finalisedAtUtc = uint64(block.timestamp);
        b.status = BetStatus.FINALISED;

        emit DisputeFinalised(betId, msg.sender, finalWinnerSide, challengeCorrect);
    }

    /**
     * Permissionless settlement.
     *
     * Paths:
     * - No challenge: after window ends and proposed winner exists.
     * - Dispute: after resolver finalises dispute.
     */
    function settle(uint256 betId) external betExists(betId) nonReentrant {
        Bet storage b = bets[betId];
        refreshStatus(betId);

        if (!b.takerFunded) revert NoTaker();
        if (b.settled) revert AlreadySettled();

        if (b.status == BetStatus.FINALISED) {
            if (!_validWinnerSide(b.finalWinnerSide)) revert InvalidWinnerSide();

            if (b.challengerWallet != address(0)) {
                _settleDisputed(betId, b, msg.sender);
            } else {
                _settleWinnerOnly(betId, b, msg.sender);
            }

            return;
        }

        if (b.status != BetStatus.RESOLUTION_WINDOW_OPEN) revert InvalidState();
        if (b.proposedWinnerSide == 0) revert NoProposedWinner();

        uint256 windowStart = _windowStart(b);
        if (windowStart == 0) revert ResolutionWindowNotOpen();
        if (block.timestamp < windowStart + RESOLUTION_WINDOW) revert ResolutionWindowStillOpen();

        b.finalWinnerSide = b.proposedWinnerSide;
        b.finalisedAtUtc = uint64(block.timestamp);

        _settleWinnerOnly(betId, b, msg.sender);
    }

    /**
     * Timeout/no-action path.
     * Only applies if resolution window ended and nobody claimed/conceded/challenged.
     */
    function timeoutResolve(uint256 betId) external betExists(betId) nonReentrant {
        Bet storage b = bets[betId];
        refreshStatus(betId);

        if (!b.takerFunded) revert NoTaker();
        if (b.settled) revert AlreadySettled();
        if (b.status != BetStatus.RESOLUTION_WINDOW_OPEN) revert ResolutionWindowNotOpen();
        if (b.proposedWinnerSide != 0) revert InvalidState();

        uint256 windowStart = _windowStart(b);
        if (windowStart == 0) revert ResolutionWindowNotOpen();
        if (block.timestamp < windowStart + RESOLUTION_WINDOW) revert ResolutionWindowStillOpen();

        b.settled = true;
        b.status = BetStatus.SETTLED;
        b.finalisedAtUtc = uint64(block.timestamp);

        uint256 pot = b.stake * 2;

        uint256 creatorRefund = (pot * TIMEOUT_CREATOR_REFUND_BPS) / BPS;
        uint256 takerRefund = (pot * TIMEOUT_TAKER_REFUND_BPS) / BPS;
        uint256 callerAmt = (pot * TIMEOUT_CALLER_BPS) / BPS;
        uint256 treasuryAmt = (pot * TIMEOUT_TREASURY_BPS) / BPS;
        uint256 burnAmt = (pot * TIMEOUT_BURN_BPS) / BPS;

        uint256 distributed = creatorRefund + takerRefund + callerAmt + treasuryAmt + burnAmt;
        uint256 dust = pot - distributed;

        token.safeTransfer(b.creatorWallet, creatorRefund);
        token.safeTransfer(b.takerWallet, takerRefund);
        token.safeTransfer(msg.sender, callerAmt);
        token.safeTransfer(treasury, treasuryAmt + dust);
        token.safeTransfer(BURN, burnAmt);

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

    function challengeBondAmount(uint256 betId) public view betExists(betId) returns (uint256) {
        return (bets[betId].stake * CHALLENGE_BOND_BPS) / BPS;
    }

    function potAmount(uint256 betId) external view betExists(betId) returns (uint256) {
        return bets[betId].stake * 2;
    }

    function callerRewardAmount(uint256 betId) public view betExists(betId) returns (uint256) {
        return ((bets[betId].stake * 2) * CALLER_REWARD_BPS) / BPS;
    }

    function canJoin(uint256 betId) external view betExists(betId) returns (bool) {
        Bet storage b = bets[betId];

        return
            b.creatorFunded &&
            !b.takerFunded &&
            block.timestamp < b.closeTimeUtc &&
            (b.status == BetStatus.CREATED || b.status == BetStatus.LIVE);
    }

    function canClaimWin(uint256 betId, address user) external view betExists(betId) returns (bool) {
        Bet storage b = bets[betId];

        if (!_isParticipant(b, user)) return false;
        if (b.resolutionType == ResolutionType.VERIFIABLE) return false;
        if (!b.takerFunded) return false;
        if (b.proposedWinnerSide != 0) return false;
        if (b.status != BetStatus.RESOLUTION_WINDOW_OPEN) {
            if (
                !(
                    (b.status == BetStatus.CLOSED || b.status == BetStatus.WAITING_RESULT) &&
                    block.timestamp >= b.resultExpectedByUtc
                )
            ) {
                return false;
            }
        }

        return _insideWindowView(b);
    }

    function canConcede(uint256 betId, address user) external view betExists(betId) returns (bool) {
        Bet storage b = bets[betId];

        if (!_isParticipant(b, user)) return false;
        if (!b.takerFunded) return false;
        if (b.proposedWinnerSide == 0) return false;
        if (b.status != BetStatus.RESOLUTION_WINDOW_OPEN) return false;
        if (!_insideWindowView(b)) return false;

        return user == _sideWalletView(b, _oppositeSide(b.proposedWinnerSide));
    }

    function canChallenge(uint256 betId, address user) external view betExists(betId) returns (bool) {
        Bet storage b = bets[betId];

        if (!_isParticipant(b, user)) return false;
        if (!b.takerFunded) return false;
        if (b.proposedWinnerSide == 0) return false;
        if (b.status != BetStatus.RESOLUTION_WINDOW_OPEN) return false;
        if (!_insideWindowView(b)) return false;

        return user == _sideWalletView(b, _oppositeSide(b.proposedWinnerSide));
    }

    function canSettle(uint256 betId) external view betExists(betId) returns (bool) {
        Bet storage b = bets[betId];

        if (!b.takerFunded || b.settled) return false;

        if (b.status == BetStatus.FINALISED && _validWinnerSide(b.finalWinnerSide)) {
            return true;
        }

        if (b.status != BetStatus.RESOLUTION_WINDOW_OPEN) return false;
        if (b.proposedWinnerSide == 0) return false;

        uint256 windowStart = _windowStart(b);
        if (windowStart == 0) return false;

        return block.timestamp >= windowStart + RESOLUTION_WINDOW;
    }

    function canTimeoutResolve(uint256 betId) external view betExists(betId) returns (bool) {
        Bet storage b = bets[betId];

        if (!b.takerFunded || b.settled) return false;
        if (b.status != BetStatus.RESOLUTION_WINDOW_OPEN) return false;
        if (b.proposedWinnerSide != 0) return false;

        uint256 windowStart = _windowStart(b);
        if (windowStart == 0) return false;

        return block.timestamp >= windowStart + RESOLUTION_WINDOW;
    }

    function _settleWinnerOnly(
        uint256 betId,
        Bet storage b,
        address caller
    ) internal {
        if (b.settled) revert AlreadySettled();

        uint8 winnerSide = b.finalWinnerSide;
        if (!_validWinnerSide(winnerSide)) revert InvalidWinnerSide();

        b.settled = true;
        b.status = BetStatus.SETTLED;

        uint256 pot = b.stake * 2;
        uint256 callerReward = (pot * CALLER_REWARD_BPS) / BPS;
        uint256 winnerAmount = pot - callerReward;

        address winnerWallet = _sideWallet(b, winnerSide);

        token.safeTransfer(winnerWallet, winnerAmount);
        token.safeTransfer(caller, callerReward);

        emit BetSettled(betId, caller, winnerWallet, winnerAmount, callerReward);
    }

    function _settleDisputed(
        uint256 betId,
        Bet storage b,
        address caller
    ) internal {
        if (b.settled) revert AlreadySettled();

        uint8 winnerSide = b.finalWinnerSide;
        if (!_validWinnerSide(winnerSide)) revert InvalidWinnerSide();

        b.settled = true;
        b.status = BetStatus.SETTLED;

        uint256 pot = b.stake * 2;
        uint256 callerReward = (pot * CALLER_REWARD_BPS) / BPS;
        uint256 winnerAmount = pot - callerReward;

        address winnerWallet = _sideWallet(b, winnerSide);

        token.safeTransfer(winnerWallet, winnerAmount);
        token.safeTransfer(caller, callerReward);

        if (b.challengeCorrect) {
            token.safeTransfer(b.challengerWallet, b.challengeBond);

            emit BetSettledWithCorrectChallenge(
                betId,
                caller,
                winnerWallet,
                b.challengerWallet,
                winnerAmount,
                callerReward,
                b.challengeBond
            );
        } else {
            uint256 treasuryBondAmount = (b.challengeBond * WRONG_BOND_TREASURY_BPS) / BPS;
            uint256 burnBondAmount = (b.challengeBond * WRONG_BOND_BURN_BPS) / BPS;
            uint256 dust = b.challengeBond - treasuryBondAmount - burnBondAmount;

            token.safeTransfer(treasury, treasuryBondAmount + dust);
            token.safeTransfer(BURN, burnBondAmount);

            emit BetSettledWithWrongChallenge(
                betId,
                caller,
                winnerWallet,
                winnerAmount,
                callerReward,
                treasuryBondAmount + dust,
                burnBondAmount
            );
        }
    }

    function _windowStart(Bet storage b) internal view returns (uint256) {
        if (b.resolutionType == ResolutionType.VERIFIABLE) {
            return b.proposalTimeUtc;
        }

        return b.resultExpectedByUtc;
    }

    function _insideWindow(Bet storage b) internal view returns (bool) {
        uint256 windowStart = _windowStart(b);
        if (windowStart == 0) return false;

        return block.timestamp >= windowStart && block.timestamp < windowStart + RESOLUTION_WINDOW;
    }

    function _insideWindowView(Bet storage b) internal view returns (bool) {
        uint256 windowStart = _windowStart(b);
        if (windowStart == 0) return false;

        return block.timestamp >= windowStart && block.timestamp < windowStart + RESOLUTION_WINDOW;
    }

    function _isParticipant(Bet storage b, address user) internal view returns (bool) {
        return user == b.creatorWallet || user == b.takerWallet;
    }

    function _sideWallet(Bet storage b, uint8 side) internal view returns (address) {
        if (side == 1) return b.creatorWallet;
        if (side == 2) return b.takerWallet;
        revert InvalidWinnerSide();
    }

    function _sideWalletView(Bet storage b, uint8 side) internal view returns (address) {
        if (side == 1) return b.creatorWallet;
        if (side == 2) return b.takerWallet;
        return address(0);
    }

    function _oppositeSide(uint8 side) internal pure returns (uint8) {
        if (side == 1) return 2;
        if (side == 2) return 1;
        revert InvalidWinnerSide();
    }

    function _validWinnerSide(uint8 side) internal pure returns (bool) {
        return side == 1 || side == 2;
    }
}
