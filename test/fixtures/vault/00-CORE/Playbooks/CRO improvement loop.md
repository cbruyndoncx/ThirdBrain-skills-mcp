---
type: playbook
title: CRO improvement loop
trigger: This page isn't converting
outcome: Optimised page with A/B test running
total-steps: 5
estimated-duration: 1-2 hours, single session
status: active
tags:
- cro
value-chain: lead-to-cash
chain-coverage:
- propose
- close
---

# CRO Improvement Loop

## Required Context

- Page URL or screenshot

## Steps

1 (5). cro → audit page for conversion issues (AGENT)
2 (4). Prioritise which issues to fix (HUMAN)
3 (3). copywriting → rewrite copy for top issues (AGENT)
4 (2). ab-test-setup → design test variants + hypothesis (AGENT)
5 (1). Document decisions and carry forward (HUMAN + AGENT)

## Sequence Diagram

![[cro-loop-sequence.png]]

## Quality gate

- A/B test hypothesis is falsifiable
