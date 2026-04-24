// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Escrow {
    address public creator;
    address public taker;

    uint256 public stake;
    bool public creatorFunded;
    bool public takerFunded;

    bool public resolved;
    address public winner;

    constructor(uint256 _stake) {
        creator = msg.sender;
        stake = _stake;
    }

    function fundCreator() external payable {
        require(msg.sender == creator, "Not creator");
        require(!creatorFunded, "Already funded");
        require(msg.value == stake, "Incorrect stake");

        creatorFunded = true;
    }

    function joinAsTaker() external payable {
        require(!takerFunded, "Already joined");
        require(msg.value == stake, "Incorrect stake");

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

        uint256 balance = address(this).balance;
        payable(winner).transfer(balance);
    }
}