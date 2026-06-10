// Balance computation and debt simplification. All amounts in AUD.

// Net position per member for a group: positive = is owed money.
// Expenses where amountAUD is missing (rate unavailable at entry) fall
// back to the raw amount so they still count rather than vanish.
export function computeNets(group) {
  const nets = {};
  for (const id of group.members || []) nets[id] = 0;

  for (const exp of Object.values(group.expenses || {})) {
    const totalAUD = exp.amountAUD ?? exp.amount;
    if (nets[exp.paidBy] === undefined) nets[exp.paidBy] = 0;
    nets[exp.paidBy] += totalAUD;
    const splitTotal = Object.values(exp.splits || {}).reduce((a, b) => a + b, 0) || 1;
    for (const [mid, share] of Object.entries(exp.splits || {})) {
      if (nets[mid] === undefined) nets[mid] = 0;
      nets[mid] -= totalAUD * (share / splitTotal);
    }
  }

  for (const s of Object.values(group.settlements || {})) {
    if (nets[s.from] === undefined) nets[s.from] = 0;
    if (nets[s.to] === undefined) nets[s.to] = 0;
    nets[s.from] += s.amount;
    nets[s.to] -= s.amount;
  }

  for (const id of Object.keys(nets)) nets[id] = Math.round(nets[id] * 100) / 100;
  return nets;
}

// Minimum-transaction settle-up: greedy largest-debtor → largest-creditor.
export function simplifyDebts(nets) {
  const debtors = [], creditors = [];
  for (const [id, v] of Object.entries(nets)) {
    if (v < -0.005) debtors.push({ id, amt: -v });
    else if (v > 0.005) creditors.push({ id, amt: v });
  }
  debtors.sort((a, b) => b.amt - a.amt);
  creditors.sort((a, b) => b.amt - a.amt);

  const txns = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    txns.push({ from: debtors[i].id, to: creditors[j].id, amount: Math.round(pay * 100) / 100 });
    debtors[i].amt -= pay;
    creditors[j].amt -= pay;
    if (debtors[i].amt < 0.005) i++;
    if (creditors[j].amt < 0.005) j++;
  }
  return txns;
}

// Equal split of `amount` among `memberIds`, distributing leftover cents.
export function equalSplit(amount, memberIds) {
  const cents = Math.round(amount * 100);
  const n = memberIds.length;
  const base = Math.floor(cents / n);
  let remainder = cents - base * n;
  const splits = {};
  for (const id of memberIds) {
    splits[id] = (base + (remainder > 0 ? 1 : 0)) / 100;
    if (remainder > 0) remainder--;
  }
  return splits;
}
