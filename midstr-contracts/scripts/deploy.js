import { network } from "hardhat";

async function main() {
  const { ethers } = await network.connect("sepolia");

  const token = "0xC4D1d1AD79ad3c519D1d342D66674550d9304507";
  const treasury = "0x56CD181eDE59241e38eD0Bd34F570EaA9a5312db";
  const aiResolver = "0x8430BFECC29BF6A28a8fE431bb6EDB3c19c91d34";

  const EscrowTokenV3 = await ethers.getContractFactory("EscrowTokenV3");
  const escrow = await EscrowTokenV3.deploy(token, treasury, aiResolver);

  await escrow.waitForDeployment();

  console.log("EscrowTokenV3 deployed to:", escrow.target);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});