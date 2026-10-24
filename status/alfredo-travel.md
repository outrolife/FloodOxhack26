# alfredo-travel

- **role**: Model
- **state**: blocked
- **issue**: #7
- **task**: Travel times (SPEC 6) PR #37 open: 11 pairs, Thames -> newbotley/minns/coldharbour + Cherwell (PR #30)
- **next**: When hourly.parquet lands: run, commit travel_times.json, switch PR #37 to Closes #7
- **needs**: hourly.parquet at shared data/processed from s-s01s-pipeline (#3)
- **notes**: lags.json = {pairs:[{up,down,lag_lo,lag_main,lag_hi,source}]} (PR #31 reads it). Stand-in run: enslow->kingsmill 18.6h n=6, cassington->newbotley 9.5h n=24
- **branch**: model/travel-times
- **head**: ee08a87 Retarget travel-time pairs to newbotley, minns and coldharbour
- **unpushed**: 0
- **dirty**: 0
- **updated**: 2026-10-24T16:22:38Z
