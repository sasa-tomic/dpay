// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {MockZCHF} from "../src/MockZCHF.sol";

interface Vm {
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external returns (address);
    function expectRevert(bytes calldata revertData) external;
    function warp(uint256 timestamp) external;
    function prank(address msgSender) external;
}

/// Dev-only proof of the dpay offline-payment flow on the mock: payer signs an EIP-2612
/// permit offline, merchant later calls permit + transferFrom (pull-claim, flow-177 twin).
contract MockZCHFTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 deadline,uint256 nonce)");
    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(uint256 chainId,address verifyingContract)");

    function _digest(MockZCHF z, address owner, address spender, uint256 value, uint256 deadline, uint256 nonce)
        internal
        view
        returns (bytes32)
    {
        // Minimal EIP-712 domain, mirroring the real ZCHF (ERC20PermitLight on both chains).
        bytes32 ds = keccak256(abi.encode(DOMAIN_TYPEHASH, block.chainid, address(z)));
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, deadline, nonce));
        return keccak256(abi.encodePacked("\x19\x01", ds, structHash));
    }

    function test_offline_permit_pull_claim() public {
        MockZCHF z = new MockZCHF();
        uint256 payerKey = 0xA11CE;
        address payer = vm.addr(payerKey);
        address merchant = address(0xC0FFEE);
        uint256 deadline = block.timestamp + 1 hours;

        z.transfer(payer, 100e18); // payer funded on a previous online session
        require(z.balanceOf(payer) == 100e18, "payer funded");

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, _digest(z, payer, merchant, 100e18, deadline, 0));
        z.permit(payer, merchant, 100e18, deadline, v, r, s); // merchant settles when back online
        vm.prank(merchant);
        z.transferFrom(payer, merchant, 100e18);
        require(z.balanceOf(merchant) == 100e18, "merchant paid");
        require(z.balanceOf(payer) == 0, "payer drained");
    }

    function test_expired_permit_reverts() public {
        MockZCHF z = new MockZCHF();
        uint256 payerKey = 0xB0B;
        address payer = vm.addr(payerKey);
        address merchant = address(0xC0FFEE);
        uint256 deadline = block.timestamp + 10;

        z.transfer(payer, 5e18);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, _digest(z, payer, merchant, 5e18, deadline, 0));
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "PERMIT_DEADLINE_EXPIRED"));
        z.permit(payer, merchant, 5e18, deadline, v, r, s);
    }

    function test_permit_nonce_single_use() public {
        MockZCHF z = new MockZCHF();
        uint256 payerKey = 0xC0C0A;
        address payer = vm.addr(payerKey);
        address merchant = address(0xC0FFEE);
        uint256 deadline = block.timestamp + 1 hours;

        z.transfer(payer, 7e18);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, _digest(z, payer, merchant, 7e18, deadline, 0));
        z.permit(payer, merchant, 7e18, deadline, v, r, s);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "INVALID_SIGNER")); // same sig replay must fail
        z.permit(payer, merchant, 7e18, deadline, v, r, s);
        require(z.nonces(payer) == 1, "nonce advanced");
    }
}
