import { encodeFunctionData } from "viem";
import { EvmWalletProvider } from "./wallet-providers";
import { approve, applyGasMultiplier, retryWithExponentialBackoff } from "./utils";

const MOCK_TOKEN_ADDRESS = "0x1234567890123456789012345678901234567890";
const MOCK_SPENDER_ADDRESS = "0x9876543210987654321098765432109876543210";
const MOCK_AMOUNT = BigInt("1000000000000000000");
const MOCK_TX_HASH = "0xabcdef1234567890";
const MOCK_RECEIPT = { status: 1, blockNumber: 1234567 };

describe("utils", () => {
  describe("approve", () => {
    let mockWallet: jest.Mocked<EvmWalletProvider>;

    beforeEach(() => {
      mockWallet = {
        sendTransaction: jest.fn().mockResolvedValue(MOCK_TX_HASH as `0x${string}`),
        waitForTransactionReceipt: jest.fn().mockResolvedValue(MOCK_RECEIPT),
      } as unknown as jest.Mocked<EvmWalletProvider>;
    });

    it("should successfully approve tokens", async () => {
      const response = await approve(
        mockWallet,
        MOCK_TOKEN_ADDRESS,
        MOCK_SPENDER_ADDRESS,
        MOCK_AMOUNT,
      );

      expect(mockWallet.sendTransaction).toHaveBeenCalledWith({
        to: MOCK_TOKEN_ADDRESS as `0x${string}`,
        data: encodeFunctionData({
          abi: [
            {
              inputs: [
                { name: "spender", type: "address" },
                { name: "amount", type: "uint256" },
              ],
              name: "approve",
              outputs: [{ name: "", type: "bool" }],
              stateMutability: "nonpayable",
              type: "function",
            },
          ],
          functionName: "approve",
          args: [MOCK_SPENDER_ADDRESS as `0x${string}`, MOCK_AMOUNT],
        }),
      });

      expect(mockWallet.waitForTransactionReceipt).toHaveBeenCalledWith(MOCK_TX_HASH);
      expect(response).toBe(
        `Successfully approved ${MOCK_SPENDER_ADDRESS} to spend ${MOCK_AMOUNT} tokens`,
      );
    });

    it("should handle approval errors", async () => {
      const error = new Error("Failed to approve");
      mockWallet.sendTransaction.mockRejectedValue(error);

      const response = await approve(
        mockWallet,
        MOCK_TOKEN_ADDRESS,
        MOCK_SPENDER_ADDRESS,
        MOCK_AMOUNT,
      );

      expect(response).toBe(`Error approving tokens: ${error}`);
    });
  });

  describe("applyGasMultiplier", () => {
    it("should scale gas estimate by multiplier", () => {
      const gas = BigInt(21000);
      const multiplier = 1.2;
      const result = applyGasMultiplier(gas, multiplier);
      expect(result).toBe(BigInt(25200));
    });

    it("should handle multiplier of 1 (no change)", () => {
      const gas = BigInt(100000);
      const result = applyGasMultiplier(gas, 1);
      expect(result).toBe(BigInt(100000));
    });

    it("should handle multiplier less than 1", () => {
      const gas = BigInt(100000);
      const result = applyGasMultiplier(gas, 0.5);
      expect(result).toBe(BigInt(50000));
    });

    it("should round to nearest integer", () => {
      const gas = BigInt(100);
      const multiplier = 1.5;
      const result = applyGasMultiplier(gas, multiplier);
      expect(result).toBe(BigInt(150));
    });

    it("should handle very large gas values", () => {
      const gas = BigInt("1000000000000");
      const multiplier = 1.1;
      const result = applyGasMultiplier(gas, multiplier);
      expect(result).toBe(BigInt("1100000000000"));
    });

    it("should handle zero gas", () => {
      const gas = BigInt(0);
      const result = applyGasMultiplier(gas, 1.5);
      expect(result).toBe(BigInt(0));
    });
  });

  describe("retryWithExponentialBackoff", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("should return result on first successful attempt", async () => {
      const fn = jest.fn().mockResolvedValue("success");
      const promise = retryWithExponentialBackoff(fn);
      const result = await promise;
      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should retry on failure and succeed eventually", async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error("fail1"))
        .mockRejectedValueOnce(new Error("fail2"))
        .mockResolvedValue("success");

      const promise = retryWithExponentialBackoff(fn, 3, 100, 0);

      // First attempt fails immediately
      await jest.advanceTimersByTimeAsync(0);
      // Wait for first retry delay (100ms)
      await jest.advanceTimersByTimeAsync(100);
      // Wait for second retry delay (200ms)
      await jest.advanceTimersByTimeAsync(200);

      const result = await promise;
      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("should throw after max retries exceeded", async () => {
      const error = new Error("persistent failure");
      const fn = jest.fn().mockRejectedValue(error);

      const promise = retryWithExponentialBackoff(fn, 2, 100, 0);

      // Advance through all retry delays
      await jest.advanceTimersByTimeAsync(100);
      await jest.advanceTimersByTimeAsync(200);

      await expect(promise).rejects.toThrow("persistent failure");
      expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it("should respect initial delay", async () => {
      const fn = jest.fn().mockResolvedValue("success");
      const promise = retryWithExponentialBackoff(fn, 3, 1000, 500);

      // Function should not be called before initial delay
      expect(fn).not.toHaveBeenCalled();

      // Advance past initial delay
      await jest.advanceTimersByTimeAsync(500);

      const result = await promise;
      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should use exponential backoff delays", async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error("fail1"))
        .mockRejectedValueOnce(new Error("fail2"))
        .mockRejectedValueOnce(new Error("fail3"))
        .mockResolvedValue("success");

      const baseDelay = 100;
      const promise = retryWithExponentialBackoff(fn, 3, baseDelay, 0);

      // First attempt
      await jest.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1);

      // First retry after 100ms (baseDelay * 2^0)
      await jest.advanceTimersByTimeAsync(100);
      expect(fn).toHaveBeenCalledTimes(2);

      // Second retry after 200ms (baseDelay * 2^1)
      await jest.advanceTimersByTimeAsync(200);
      expect(fn).toHaveBeenCalledTimes(3);

      // Third retry after 400ms (baseDelay * 2^2)
      await jest.advanceTimersByTimeAsync(400);
      expect(fn).toHaveBeenCalledTimes(4);

      const result = await promise;
      expect(result).toBe("success");
    });
  });
});

