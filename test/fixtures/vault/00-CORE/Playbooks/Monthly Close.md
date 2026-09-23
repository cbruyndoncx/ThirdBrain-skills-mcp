---
type: playbook
title: Monthly Close
trigger: Month ended
outcome: Books closed
total-steps: 3
status: active
value-chain: record-to-insight
chain-coverage:
- reconcile
- report
---
## Steps

1 (3). financial-reporting → pull P&L (AGENT)
2 (2). **Reconcile the bank.** Match statements line by line and
   flag every gap (HUMAN)

3 (1). **Check the payment page converts.** [[cro/SKILL.md|CRO audit]] on the page, then
   hand off to [[CRO improvement loop]] if it does not
   (AGENT)
