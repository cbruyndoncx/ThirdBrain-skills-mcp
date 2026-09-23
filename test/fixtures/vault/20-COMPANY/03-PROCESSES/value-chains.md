---
type: reference
title: Value chains
---
# Value chains

## Chains

### lead-to-cash
- **SME Label:** Win and get paid
- **Description:** The full revenue journey from first touch to cash collected.
- **Stages:** prospect → qualify → propose → close → deliver → invoice → collect
- **Key Playbooks:** [[CRO improvement loop]]
- **Key Skills:** cro, ab-test-setup

### record-to-insight
**SME Label:** Know your numbers
**Description:** Bookkeeping through financial clarity.
**Stages:** capture → reconcile → close-period → report → decide

## Notes

Not a chain.

## Meta-Chain: Infrastructure

Skills tagged `infrastructure` are vault machinery: they enable every chain and execute none.

| Bucket | Examples |
|--------|----------|
| Vault machinery | `playbook-runner` |

## Metadata Spec

```yaml
value-chains:
  - lead-to-cash
```

### Valid chain IDs
`lead-to-cash`, `record-to-insight`, `operating-controls`, `infrastructure`
