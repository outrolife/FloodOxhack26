# s-s01s-proof

- **role**: Model
- **state**: reviewing
- **issue**: #11
- **task**: PR #66 ready: proof.json + 6 replays on main's model code
- **next**: fix review comments; idle after merge
- **needs**: 
- **notes**: (a) one target full set 6x7 = 184 s wall (all 10 cores, LightGBM default threads; ~216% CPU, data-bound); 3 targets in parallel at 3 threads each = 2-3.3 min. (b) LOFO: 16 models (e2007/e2012/e2014/e2021 x 4 targets; test-period events reuse the time-split models, identical result) est. 15-25 min at 4 procs x 2 threads, full SPEC 7.3 params, no round cap. (c) os.cpu_count()=10
- **branch**: model/proof-json
- **head**: 451ea42 Generate proof.json and replays for all spots and events
- **unpushed**: 1
- **dirty**: 0
- **updated**: 2026-10-24T17:35:17Z
