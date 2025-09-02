;; RepaymentEngine.clar
;; Core contract for automating student loan repayments based on verified employment outcomes.
;; Integrates with EmploymentOracle for income data, LoanIssuance for loan terms,
;; BorrowerProfile for borrower details, and EscrowVault for fund transfers.
;; Supports income-contingent repayments, deferrals, penalties, and grace periods.

;; Traits for dependencies
(define-trait employment-oracle-trait
  ((get-verified-income (principal) (response uint uint)))
)

(define-trait loan-issuance-trait
  ((get-loan-details (uint) (response {principal: uint, interest-rate: uint, term: uint, start-block: uint, borrower: principal} uint)))
)

(define-trait borrower-profile-trait
  ((get-borrower-status (principal) (response {is-active: bool, low-income-flag: bool} uint)))
)

(define-trait escrow-vault-trait
  ((transfer-funds (principal principal uint) (response bool uint)))
)

;; Constants
(define-constant ERR-UNAUTHORIZED u100)
(define-constant ERR-INVALID-LOAN u101)
(define-constant ERR-INVALID-INCOME u102)
(define-constant ERR-PAUSED u103)
(define-constant ERR-INVALID-AMOUNT u104)
(define-constant ERR-NO-ACTIVE-LOAN u105)
(define-constant ERR-DEFERRED u106)
(define-constant ERR-GRACE-PERIOD u107)
(define-constant ERR-INVALID-STATUS u108)
(define-constant ERR-TRANSFER-FAILED u109)
(define-constant ERR-INVALID-THRESHOLDS u110)
(define-constant ERR-NOT-LOW-INCOME u111)
(define-constant ERR-CALCULATION-OVERFLOW u112)
(define-constant ERR-ALREADY-REGISTERED u113)

(define-constant DEFAULT-THRESHOLD u20000) ;; $20,000 annual income threshold for deferral
(define-constant GRACE-PERIOD-BLOCKS u144) ;; ~1 day in blocks
(define-constant PENALTY-RATE u5) ;; 0.05% penalty per block late (scaled by 10000 for precision)
(define-constant MAX-TERM u360) ;; Max loan term in months
(define-constant SCALE-FACTOR u10000) ;; For interest/penalty precision

;; Data Variables
(define-data-var contract-paused bool false)
(define-data-var admin principal tx-sender)
(define-data-var repayment-threshold uint DEFAULT-THRESHOLD)
(define-data-var min-repayment-percentage uint u10) ;; 10% of income above threshold
(define-data-var grace-period uint GRACE-PERIOD-BLOCKS)
(define-data-var employment-oracle principal 'SP000000000000000000002Q6VF78.employment-oracle) ;; Placeholder
(define-data-var loan-issuance principal 'SP000000000000000000002Q6VF78.loan-issuance)
(define-data-var borrower-profile principal 'SP000000000000000000002Q6VF78.borrower-profile)
(define-data-var escrow-vault principal 'SP000000000000000000002Q6VF78.escrow-vault)

;; Data Maps
(define-map loan-repayments
  { loan-id: uint }
  {
    borrower: principal,
    outstanding-principal: uint,
    accrued-interest: uint,
    last-repayment-block: uint,
    status: (string-ascii 20), ;; "active", "deferred", "defaulted", "paid"
    total-paid: uint,
    deferral-count: uint,
    penalty-accrued: uint
  }
)

(define-map repayment-history
  { loan-id: uint, repayment-id: uint }
  {
    amount: uint,
    block-height: uint,
    income-at-time: uint,
    was-deferred: bool,
    penalty-applied: uint
  }
)

(define-map repayment-counters { loan-id: uint } { counter: uint })

;; Private Functions
(define-private (calculate-interest (principal uint) (rate uint) (blocks uint))
  (let
    (
      (scaled-interest (/ (* principal rate blocks) SCALE-FACTOR))
    )
    (if (> scaled-interest principal) ;; Overflow check
      (err ERR-CALCULATION-OVERFLOW)
      (ok (/ scaled-interest u100)) ;; Assuming daily compounding approximation
    )
  )
)

(define-private (calculate-penalty (outstanding uint) (blocks-late uint))
  (/ (* outstanding PENALTY-RATE blocks-late) SCALE-FACTOR)
)

(define-private (get-income (borrower principal))
  (contract-call? .employment-oracle-trait get-verified-income borrower)
)

(define-private (get-loan (loan-id uint))
  (contract-call? .loan-issuance-trait get-loan-details loan-id)
)

(define-private (get-borrower (borrower principal))
  (contract-call? .borrower-profile-trait get-borrower-status borrower)
)

(define-private (transfer-to-lender (lender principal) (borrower principal) (amount uint))
  (contract-call? .escrow-vault-trait transfer-funds borrower lender amount)
)

;; Public Functions
(define-public (pause-contract)
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR-UNAUTHORIZED))
    (ok (var-set contract-paused true))
  )
)

(define-public (unpause-contract)
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR-UNAUTHORIZED))
    (ok (var-set contract-paused false))
  )
)

(define-public (set-thresholds (new-threshold uint) (new-min-percentage uint))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR-UNAUTHORIZED))
    (asserts! (and (> new-threshold u0) (<= new-min-percentage u100)) (err ERR-INVALID-THRESHOLDS))
    (var-set repayment-threshold new-threshold)
    (ok (var-set min-repayment-percentage new-min-percentage))
  )
)

(define-public (initialize-loan-repayment (loan-id uint))
  (let
    (
      (loan (unwrap! (get-loan loan-id) (err ERR-INVALID-LOAN)))
      (borrower (get borrower loan))
      (borrower-status (unwrap! (get-borrower borrower) (err ERR-INVALID-LOAN)))
    )
    (asserts! (not (var-get contract-paused)) (err ERR-PAUSED))
    (asserts! (get is-active borrower-status) (err ERR-INVALID_STATUS))
    (asserts! (get low-income-flag borrower-status) (err ERR-NOT-LOW-INCOME))
    (asserts! (is-none (map-get? loan-repayments {loan-id: loan-id})) (err ERR-ALREADY-REGISTERED))
    (map-set loan-repayments
      {loan-id: loan-id}
      {
        borrower: borrower,
        outstanding-principal: (get principal loan),
        accrued-interest: u0,
        last-repayment-block: block-height,
        status: "active",
        total-paid: u0,
        deferral-count: u0,
        penalty-accrued: u0
      }
    )
    (map-set repayment-counters {loan-id: loan-id} {counter: u0})
    (ok true)
  )
)

(define-public (process-repayment (loan-id uint))
  (let
    (
      (repayment (unwrap! (map-get? loan-repayments {loan-id: loan-id}) (err ERR-NO-ACTIVE-LOAN)))
      (borrower (get borrower repayment))
      (income-res (get-income borrower))
      (income (unwrap! income-res (err ERR-INVALID-INCOME)))
      (loan (unwrap! (get-loan loan-id) (err ERR-INVALID-LOAN)))
      (lender tx-sender)
      (blocks-since-last (- block-height (get last-repayment-block repayment)))
      (interest (unwrap! (calculate-interest (get outstanding-principal repayment) (get interest-rate loan) blocks-since-last) (err ERR-CALCULATION-OVERFLOW)))
      (penalty (if (> blocks-since-last (var-get grace-period))
                 (calculate-penalty (get outstanding-principal repayment) (- blocks-since-last (var-get grace-period)))
                 u0))
      (total-due (+ (get outstanding-principal repayment) interest penalty))
      (repayment-amount (if (< income (var-get repayment-threshold))
                          u0
                          (/ (* (- income (var-get repayment-threshold)) (var-get min-repayment-percentage)) u100)))
      (effective-amount (min repayment-amount total-due))
      (new-principal (- (get outstanding-principal repayment) effective-amount))
      (new-status (if (is-eq new-principal u0) 
                    "paid" 
                    (if (is-eq effective-amount u0) 
                      "deferred" 
                      "active")))
      (new-deferral (if (is-eq effective-amount u0) 
                     (+ (get deferral-count repayment) u1) 
                     (get deferral-count repayment)))
      (new-penalty (+ (get penalty-accrued repayment) penalty))
      (counter (get counter (unwrap! (map-get? repayment-counters {loan-id: loan-id}) (err ERR-INVALID-LOAN))))
      (new-counter (+ counter u1))
    )
    (asserts! (not (var-get contract-paused)) (err ERR-PAUSED))
    (asserts! (> effective-amount u0) (err ERR-INVALID-AMOUNT))
    (if (is-eq effective-amount u0)
      (begin
        (map-set loan-repayments {loan-id: loan-id}
          (merge repayment {
            status: new-status,
            deferral-count: new-deferral,
            last-repayment-block: block-height,
            accrued-interest: (+ (get accrued-interest repayment) interest),
            penalty-accrued: new-penalty
          })
        )
        (map-set repayment-history {loan-id: loan-id, repayment-id: new-counter}
          {
            amount: u0,
            block-height: block-height,
            income-at-time: income,
            was-deferred: true,
            penalty-applied: penalty
          }
        )
        (map-set repayment-counters {loan-id: loan-id} {counter: new-counter})
        (err ERR-DEFERRED)
      )
      (let
        (
          (transfer-res (transfer-to-lender lender borrower effective-amount))
        )
        (unwrap! transfer-res (err ERR-TRANSFER-FAILED))
        (map-set loan-repayments {loan-id: loan-id}
          (merge repayment {
            outstanding-principal: new-principal,
            accrued-interest: u0,
            last-repayment-block: block-height,
            status: new-status,
            total-paid: (+ (get total-paid repayment) effective-amount),
            penalty-accrued: new-penalty
          })
        )
        (map-set repayment-history {loan-id: loan-id, repayment-id: new-counter}
          {
            amount: effective-amount,
            block-height: block-height,
            income-at-time: income,
            was-deferred: false,
            penalty-applied: penalty
          }
        )
        (map-set repayment-counters {loan-id: loan-id} {counter: new-counter})
        (ok effective-amount)
      )
    )
  )
)

;; Read-only Functions
(define-read-only (get-repayment-details (loan-id uint))
  (map-get? loan-repayments {loan-id: loan-id})
)

(define-read-only (get-repayment-history-entry (loan-id uint) (repayment-id uint))
  (map-get? repayment-history {loan-id: loan-id, repayment-id: repayment-id})
)

(define-read-only (get-contract-config)
  {
    paused: (var-get contract-paused),
    threshold: (var-get repayment-threshold),
    min-percentage: (var-get min-repayment-percentage),
    grace-period: (var-get grace-period)
  }
)

(define-read-only (calculate-expected-repayment (loan-id uint) (hypothetical-income uint))
  (let
    (
      (repayment (unwrap-panic (map-get? loan-repayments {loan-id: loan-id})))
      (loan (unwrap-panic (get-loan loan-id)))
      (blocks-since-last (- block-height (get last-repayment-block repayment)))
      (interest (unwrap-panic (calculate-interest (get outstanding-principal repayment) (get interest-rate loan) blocks-since-last)))
      (penalty (if (> blocks-since-last (var-get grace-period))
                 (calculate-penalty (get outstanding-principal repayment) (- blocks-since-last (var-get grace-period)))
                 u0))
      (total-due (+ (get outstanding-principal repayment) interest penalty))
      (repayment-amount (if (< hypothetical-income (var-get repayment-threshold))
                          u0
                          (/ (* (- hypothetical-income (var-get repayment-threshold)) (var-get min-repayment-percentage)) u100)))
    )
    (min repayment-amount total-due)
  )
)

;; Admin function to update dependencies
(define-public (update-dependencies (new-oracle principal) (new-loan-issuance principal) (new-borrower-profile principal) (new-escrow-vault principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR-UNAUTHORIZED))
    (var-set employment-oracle new-oracle)
    (var-set loan-issuance new-loan-issuance)
    (var-set borrower-profile new-borrower-profile)
    (var-set escrow-vault new-escrow-vault)
    (ok true)
  )
)

;; Event emission simulation (Clarity doesn't have events, but we can print for logs)
(define-private (emit-event (event-type (string-ascii 20)) (details (tuple (key uint) (value uint))))
  (print { event: event-type, details: details })
)