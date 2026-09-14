// Goal funding-gap math for the FolioXpert AI report.
//
// Every rate used here is an assumption the advisor types in and can edit - never a
// number this code invents or silently defaults deep in the math. The caller is
// responsible for passing a real assumedReturnPct; this module just does the arithmetic
// honestly and shows its work (monthly rate used, number of months, formula intent).

function round0(n) { return n === null || n === undefined || !isFinite(n) ? null : Math.round(n); }
function round1(n) { return n === null || n === undefined || !isFinite(n) ? null : Math.round(n * 10) / 10; }

// Standard future-value-of-(lumpsum + monthly SIP) projection.
// currentValue: today's value of money already earmarked for this goal (rupees)
// monthlySip: current monthly contribution earmarked for this goal (rupees, can be 0)
// years: time remaining to the goal (can be fractional)
// annualReturnPct: the ADVISOR'S assumed annual return, e.g. 11 for 11% - not invented here
function projectGoal({ currentValue = 0, monthlySip = 0, years, annualReturnPct }) {
  if (!years || years <= 0 || annualReturnPct === null || annualReturnPct === undefined || !isFinite(annualReturnPct)) {
    return null; // nothing sensible to compute without a horizon and a stated rate
  }
  const months = Math.round(years * 12);
  const rAnnual = annualReturnPct / 100;
  // Nominal monthly rate (annual/12), matching the convention this app's existing SIP and
  // Goal calculators already use (see computeStepupSip/computeGoal in public/index.html) -
  // kept consistent deliberately so this report's numbers don't quietly disagree with the
  // advisor's other planning tools in the same product.
  const rMonthly = rAnnual / 12;

  const fvLumpsum = currentValue * Math.pow(1 + rAnnual, years);
  // Ordinary future value of an annuity (contribution at end of each month), then bumped
  // one month of growth to approximate a start-of-month SIP, which is how most Indian
  // SIPs are actually debited.
  const fvSip = rMonthly > 0
    ? monthlySip * ((Math.pow(1 + rMonthly, months) - 1) / rMonthly) * (1 + rMonthly)
    : monthlySip * months;

  return {
    projectedValue: round0(fvLumpsum + fvSip),
    fvFromCurrentHoldings: round0(fvLumpsum),
    fvFromFutureSip: round0(fvSip),
    monthsUsed: months,
    monthlyRateUsed: round1(rMonthly * 100),
    annualReturnPctUsed: annualReturnPct,
  };
}

// Given a shortfall, the flat additional monthly SIP that would close it by the target
// date at the same assumed rate. Returns null if there's no shortfall or no valid horizon.
function requiredAdditionalSip({ gap, years, annualReturnPct }) {
  if (!gap || gap <= 0 || !years || years <= 0 || annualReturnPct === null || annualReturnPct === undefined) return null;
  const months = Math.round(years * 12);
  const rAnnual = annualReturnPct / 100;
  const rMonthly = rAnnual / 12; // see note in projectGoal - kept consistent with the app's existing calculators
  const annuityFactor = rMonthly > 0
    ? ((Math.pow(1 + rMonthly, months) - 1) / rMonthly) * (1 + rMonthly)
    : months;
  if (!annuityFactor) return null;
  return round0(gap / annuityFactor);
}

// Full goal-outlook bundle for one goal, given the portion of the portfolio the advisor
// has allocated to it (currentValue), its own monthly SIP if any, and the advisor's
// stated assumed return for the projection.
function goalOutlook(goal) {
  const { targetAmount, years, currentValue = 0, monthlySip = 0, annualReturnPct } = goal;
  const projection = projectGoal({ currentValue, monthlySip, years, annualReturnPct });
  if (!projection || !targetAmount) {
    return { ...goal, projection: null, gap: null, additionalMonthlySipRequired: null, onTrack: null };
  }
  const gap = round0(targetAmount - projection.projectedValue);
  const onTrack = gap <= 0;
  const additionalMonthlySipRequired = onTrack ? 0 : requiredAdditionalSip({ gap, years, annualReturnPct });
  return { ...goal, projection, gap, additionalMonthlySipRequired, onTrack };
}

module.exports = { projectGoal, requiredAdditionalSip, goalOutlook };
