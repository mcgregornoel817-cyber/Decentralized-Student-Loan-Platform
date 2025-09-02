// RepaymentEngine.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface LoanRepayment {
  borrower: string;
  outstandingPrincipal: number;
  accruedInterest: number;
  lastRepaymentBlock: number;
  status: string;
  totalPaid: number;
  deferralCount: number;
  penaltyAccrued: number;
}

interface RepaymentHistory {
  amount: number;
  blockHeight: number;
  incomeAtTime: number;
  wasDeferred: boolean;
  penaltyApplied: number;
}

interface ContractConfig {
  paused: boolean;
  threshold: number;
  minPercentage: number;
  gracePeriod: number;
}

interface LoanDetails {
  principal: number;
  interestRate: number;
  term: number;
  startBlock: number;
  borrower: string;
}

interface BorrowerStatus {
  isActive: boolean;
  lowIncomeFlag: boolean;
}

interface ContractState {
  paused: boolean;
  admin: string;
  repaymentThreshold: number;
  minRepaymentPercentage: number;
  gracePeriod: number;
  employmentOracle: string;
  loanIssuance: string;
  borrowerProfile: string;
  escrowVault: string;
  loanRepayments: Map<number, LoanRepayment>;
  repaymentHistory: Map<string, RepaymentHistory>; // Key as `${loanId}-${repaymentId}`
  repaymentCounters: Map<number, number>;
  currentBlock: number; // Mock block height
}

// Mock dependencies
class MockEmploymentOracle {
  getVerifiedIncome(borrower: string): ClarityResponse<number> {
    // Mock incomes
    const incomes: Record<string, number> = {
      'borrower1': 25000,
      'borrower2': 15000,
    };
    return { ok: true, value: incomes[borrower] ?? 0 };
  }
}

class MockLoanIssuance {
  getLoanDetails(loanId: number): ClarityResponse<LoanDetails> {
    // Mock loans
    const loans: Record<number, LoanDetails> = {
      1: { principal: 10000, interestRate: 500, term: 120, startBlock: 1000, borrower: 'borrower1' }, // 5% rate (scaled)
      2: { principal: 20000, interestRate: 600, term: 240, startBlock: 1000, borrower: 'borrower2' },
    };
    const loan = loans[loanId];
    return loan ? { ok: true, value: loan } : { ok: false, value: 101 };
  }
}

class MockBorrowerProfile {
  getBorrowerStatus(borrower: string): ClarityResponse<BorrowerStatus> {
    // Mock statuses
    const statuses: Record<string, BorrowerStatus> = {
      'borrower1': { isActive: true, lowIncomeFlag: true },
      'borrower2': { isActive: true, lowIncomeFlag: true },
      'inactive': { isActive: false, lowIncomeFlag: false },
    };
    const status = statuses[borrower];
    return status ? { ok: true, value: status } : { ok: false, value: 101 };
  }
}

class MockEscrowVault {
  transferFunds(from: string, to: string, amount: number): ClarityResponse<boolean> {
    // Always succeed for mocks
    return { ok: true, value: true };
  }
}

// Mock contract implementation
class RepaymentEngineMock {
  private state: ContractState = {
    paused: false,
    admin: 'deployer',
    repaymentThreshold: 20000,
    minRepaymentPercentage: 10,
    gracePeriod: 144,
    employmentOracle: 'oracle',
    loanIssuance: 'loan-issuance',
    borrowerProfile: 'borrower-profile',
    escrowVault: 'escrow-vault',
    loanRepayments: new Map(),
    repaymentHistory: new Map(),
    repaymentCounters: new Map(),
    currentBlock: 1000, // Starting block
  };

  private ERR_UNAUTHORIZED = 100;
  private ERR_INVALID_LOAN = 101;
  private ERR_INVALID_INCOME = 102;
  private ERR_PAUSED = 103;
  private ERR_INVALID_AMOUNT = 104;
  private ERR_NO_ACTIVE_LOAN = 105;
  private ERR_DEFERRED = 106;
  private ERR_INVALID_STATUS = 108;
  private ERR_TRANSFER_FAILED = 109;
  private ERR_INVALID_THRESHOLDS = 110;
  private ERR_NOT_LOW_INCOME = 111;
  private ERR_CALCULATION_OVERFLOW = 112;
  private PENALTY_RATE = 5; // 0.05% scaled by 10000? Wait, adjust to match
  private SCALE_FACTOR = 10000;

  // Mock dependencies
  private oracle = new MockEmploymentOracle();
  private loanIssuance = new MockLoanIssuance();
  private borrowerProfile = new MockBorrowerProfile();
  private escrow = new MockEscrowVault();

  // Helper to advance block
  advanceBlock(blocks: number) {
    this.state.currentBlock += blocks;
  }

  pauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.paused = true;
    return { ok: true, value: true };
  }

  unpauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.paused = false;
    return { ok: true, value: true };
  }

  setThresholds(caller: string, newThreshold: number, newMinPercentage: number): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (newThreshold <= 0 || newMinPercentage > 100) {
      return { ok: false, value: this.ERR_INVALID_THRESHOLDS };
    }
    this.state.repaymentThreshold = newThreshold;
    this.state.minRepaymentPercentage = newMinPercentage;
    return { ok: true, value: true };
  }

  initializeLoanRepayment(loanId: number): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const loanRes = this.loanIssuance.getLoanDetails(loanId);
    if (!loanRes.ok) {
      return { ok: false, value: this.ERR_INVALID_LOAN };
    }
    const loan = loanRes.value;
    const borrowerRes = this.borrowerProfile.getBorrowerStatus(loan.borrower);
    if (!borrowerRes.ok) {
      return { ok: false, value: this.ERR_INVALID_LOAN };
    }
    const borrowerStatus = borrowerRes.value;
    if (!borrowerStatus.isActive) {
      return { ok: false, value: this.ERR_INVALID_STATUS };
    }
    if (!borrowerStatus.lowIncomeFlag) {
      return { ok: false, value: this.ERR_NOT_LOW_INCOME };
    }
    if (this.state.loanRepayments.has(loanId)) {
      return { ok: false, value: this.ERR_INVALID_LOAN }; // Already initialized
    }
    this.state.loanRepayments.set(loanId, {
      borrower: loan.borrower,
      outstandingPrincipal: loan.principal,
      accruedInterest: 0,
      lastRepaymentBlock: this.state.currentBlock,
      status: 'active',
      totalPaid: 0,
      deferralCount: 0,
      penaltyAccrued: 0,
    });
    this.state.repaymentCounters.set(loanId, 0);
    return { ok: true, value: true };
  }

  processRepayment(loanId: number): ClarityResponse<number> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const repayment = this.state.loanRepayments.get(loanId);
    if (!repayment) {
      return { ok: false, value: this.ERR_NO_ACTIVE_LOAN };
    }
    const incomeRes = this.oracle.getVerifiedIncome(repayment.borrower);
    if (!incomeRes.ok) {
      return { ok: false, value: this.ERR_INVALID_INCOME };
    }
    const income = incomeRes.value;
    const loanRes = this.loanIssuance.getLoanDetails(loanId);
    if (!loanRes.ok) {
      return { ok: false, value: this.ERR_INVALID_LOAN };
    }
    const loan = loanRes.value;
    const blocksSinceLast = this.state.currentBlock - repayment.lastRepaymentBlock;
    // Simplified interest calc for mock
    const interest = Math.floor((repayment.outstandingPrincipal * loan.interestRate * blocksSinceLast) / this.SCALE_FACTOR / 100);
    const penalty = blocksSinceLast > this.state.gracePeriod
      ? Math.floor((repayment.outstandingPrincipal * this.PENALTY_RATE * (blocksSinceLast - this.state.gracePeriod)) / this.SCALE_FACTOR)
      : 0;
    const totalDue = repayment.outstandingPrincipal + interest + penalty;
    const repaymentAmount = income < this.state.repaymentThreshold
      ? 0
      : Math.floor(((income - this.state.repaymentThreshold) * this.state.minRepaymentPercentage) / 100);
    const effectiveAmount = Math.min(repaymentAmount, totalDue);
    if (effectiveAmount === 0) {
      // Defer
      this.state.loanRepayments.set(loanId, {
        ...repayment,
        status: 'deferred',
        deferralCount: repayment.deferralCount + 1,
        lastRepaymentBlock: this.state.currentBlock,
        accruedInterest: repayment.accruedInterest + interest,
        penaltyAccrued: repayment.penaltyAccrued + penalty,
      });
      const counter = (this.state.repaymentCounters.get(loanId) ?? 0) + 1;
      this.state.repaymentHistory.set(`${loanId}-${counter}`, {
        amount: 0,
        blockHeight: this.state.currentBlock,
        incomeAtTime: income,
        wasDeferred: true,
        penaltyApplied: penalty,
      });
      this.state.repaymentCounters.set(loanId, counter);
      return { ok: false, value: this.ERR_DEFERRED };
    }
    const transferRes = this.escrow.transferFunds(repayment.borrower, 'lender', effectiveAmount); // Mock lender
    if (!transferRes.ok) {
      return { ok: false, value: this.ERR_TRANSFER_FAILED };
    }
    const newPrincipal = repayment.outstandingPrincipal - effectiveAmount;
    this.state.loanRepayments.set(loanId, {
      ...repayment,
      outstandingPrincipal: newPrincipal,
      accruedInterest: 0,
      lastRepaymentBlock: this.state.currentBlock,
      status: newPrincipal === 0 ? 'paid' : 'active',
      totalPaid: repayment.totalPaid + effectiveAmount,
      penaltyAccrued: repayment.penaltyAccrued + penalty,
    });
    const counter = (this.state.repaymentCounters.get(loanId) ?? 0) + 1;
    this.state.repaymentHistory.set(`${loanId}-${counter}`, {
      amount: effectiveAmount,
      blockHeight: this.state.currentBlock,
      incomeAtTime: income,
      wasDeferred: false,
      penaltyApplied: penalty,
    });
    this.state.repaymentCounters.set(loanId, counter);
    return { ok: true, value: effectiveAmount };
  }

  getRepaymentDetails(loanId: number): ClarityResponse<LoanRepayment | null> {
    return { ok: true, value: this.state.loanRepayments.get(loanId) ?? null };
  }

  getRepaymentHistoryEntry(loanId: number, repaymentId: number): ClarityResponse<RepaymentHistory | null> {
    return { ok: true, value: this.state.repaymentHistory.get(`${loanId}-${repaymentId}`) ?? null };
  }

  getContractConfig(): ClarityResponse<ContractConfig> {
    return {
      ok: true,
      value: {
        paused: this.state.paused,
        threshold: this.state.repaymentThreshold,
        minPercentage: this.state.minRepaymentPercentage,
        gracePeriod: this.state.gracePeriod,
      },
    };
  }
}

// Test setup
const accounts = {
  deployer: 'deployer',
  borrower1: 'borrower1',
  borrower2: 'borrower2',
};

describe("RepaymentEngine Contract", () => {
  let contract: RepaymentEngineMock;

  beforeEach(() => {
    contract = new RepaymentEngineMock();
    vi.resetAllMocks();
  });

  it("should initialize with correct config", () => {
    const config = contract.getContractConfig();
    expect(config).toEqual({
      ok: true,
      value: {
        paused: false,
        threshold: 20000,
        minPercentage: 10,
        gracePeriod: 144,
      },
    });
  });

  it("should allow admin to pause and unpause", () => {
    let pauseRes = contract.pauseContract(accounts.deployer);
    expect(pauseRes).toEqual({ ok: true, value: true });
    let config = contract.getContractConfig();
    expect(config.value.paused).toBe(true);

    const unpauseRes = contract.unpauseContract(accounts.deployer);
    expect(unpauseRes).toEqual({ ok: true, value: true });
    config = contract.getContractConfig();
    expect(config.value.paused).toBe(false);
  });

  it("should prevent non-admin from pausing", () => {
    const pauseRes = contract.pauseContract(accounts.borrower1);
    expect(pauseRes).toEqual({ ok: false, value: 100 });
  });

  it("should initialize loan repayment for valid low-income borrower", () => {
    const initRes = contract.initializeLoanRepayment(1);
    expect(initRes).toEqual({ ok: true, value: true });
    const details = contract.getRepaymentDetails(1);
    expect(details.value).toEqual(expect.objectContaining({
      borrower: 'borrower1',
      outstandingPrincipal: 10000,
      status: 'active',
    }));
  });

  it("should process repayment for above-threshold income", () => {
    contract.initializeLoanRepayment(1);
    contract.advanceBlock(200); // Advance to accrue interest/penalty
    const processRes = contract.processRepayment(1);
    expect(processRes.ok).toBe(true);
    expect(processRes.value).toBeGreaterThan(0);
    const details = contract.getRepaymentDetails(1);
    expect(details.value.outstandingPrincipal).toBeLessThan(10000);
    const history = contract.getRepaymentHistoryEntry(1, 1);
    expect(history.value).toEqual(expect.objectContaining({
      amount: processRes.value,
      wasDeferred: false,
    }));
  });

  it("should defer repayment for below-threshold income", () => {
    contract.initializeLoanRepayment(2);
    contract.advanceBlock(200);
    const processRes = contract.processRepayment(2);
    expect(processRes).toEqual({ ok: false, value: 106 });
    const details = contract.getRepaymentDetails(2);
    expect(details.value.status).toBe('deferred');
    expect(details.value.deferralCount).toBe(1);
    const history = contract.getRepaymentHistoryEntry(2, 1);
    expect(history.value).toEqual(expect.objectContaining({
      amount: 0,
      wasDeferred: true,
    }));
  });

  it("should apply penalty after grace period", () => {
    contract.initializeLoanRepayment(1);
    contract.advanceBlock(150); // Beyond grace (144)
    const processRes = contract.processRepayment(1);
    expect(processRes.ok).toBe(true);
    const history = contract.getRepaymentHistoryEntry(1, 1);
    expect(history.value.penaltyApplied).toBeGreaterThan(0);
  });

  it("should prevent operations when paused", () => {
    contract.pauseContract(accounts.deployer);
    const initRes = contract.initializeLoanRepayment(1);
    expect(initRes).toEqual({ ok: false, value: 103 });
  });
});