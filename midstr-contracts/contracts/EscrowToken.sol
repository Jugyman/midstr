// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract EscrowToken {
    address public creator;
    address public taker;

    IERC20 public token;
    uint256 public stake;

    bool public creatorFunded;
    bool public takerFunded;

    bool public resolved;
    address public winner;

    constructor(address _token, uint256 _stake) {
        creator = msg.sender;
        token = IERC20(_token);
        stake = _stake;
    }

    function fundCreator() external {
        require(msg.sender == creator, "Not creator");
        require(!creatorFunded, "Already funded");

        bool ok = token.transferFrom(msg.sender, address(this), stake);
        require(ok, "Transfer failed");

        creatorFunded = true;
    }

    function joinAsTaker() external {
        require(!takerFunded, "Already joined");
        require(msg.sender != creator, "Creator cannot join as taker");

        bool ok = token.transferFrom(msg.sender, address(this), stake);
        require(ok, "Transfer failed");

        taker = msg.sender;
        takerFunded = true;
    }

    function resolve(address _winner) external {
        require(!resolved, "Already resolved");
        require(_winner == creator || _winner == taker, "Invalid winner");

        resolved = true;
        winner = _winner;
    }

    function claim() external {
        require(resolved, "Not resolved");
        require(msg.sender == winner, "Not winner");

        uint256 balance = token.balanceOf(address(this));
        bool ok = token.transfer(winner, balance);
        require(ok, "Payout failed");
    }
}