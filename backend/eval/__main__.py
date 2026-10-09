"""Command line: python -m eval <command> --dataset click

  check      every gold symbol exists in the index (no model calls)
  retrieval  did the right code reach the model, per stage and per ablation
             (replays recorded plans: no model calls once they're recorded)
  answers    ask every question and score the answers (one or two model calls each)
  report     print the Markdown summary of a saved run, optionally against a baseline

Run it where the databases and models are, e.g.:
  docker compose run --rm api python -m eval retrieval --dataset click
"""

import argparse
import json
import logging
import sys
from datetime import UTC, datetime
from pathlib import Path

from eval import dataset as datasets
from eval import report, runner


def _out_path(args: argparse.Namespace, mode: str) -> Path:
    if args.out:
        return Path(args.out)
    runner.RESULTS.mkdir(parents=True, exist_ok=True)
    return runner.RESULTS / f"{args.dataset}-{mode}-{datetime.now(UTC):%Y%m%d-%H%M}.json"


def compact(run: dict) -> dict:
    """A run without each case's retrieved hits: what a committed baseline needs to compare."""
    out = json.loads(json.dumps(run, default=str))
    for variant in out.get("retrieval", {}).get("variants", {}).values():
        for case in variant["cases"]:
            case.pop("stages", None)
    return out


def _write(run: dict, path: Path, baseline: str | None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Baselines are committed, so they keep scores and plans but not every retrieved hit.
    saved = compact(run) if path.resolve().parent == (runner.ROOT / "baselines").resolve() else run
    path.write_text(json.dumps(saved, indent=2, default=str) + "\n")
    base = json.loads(Path(baseline).read_text()) if baseline else None
    text = report.markdown(run, base)
    path.with_suffix(".md").write_text(text)
    print(text)
    print(f"Saved {path} and {path.with_suffix('.md')}", file=sys.stderr)


def cmd_check(args: argparse.Namespace) -> int:
    ds = datasets.load(args.dataset)
    bad = 0
    for case in ds.cases:
        for gold in case.gold:
            spans = runner.gold_spans(ds.repo, datasets.Case(case.id, case.kind, case.question, (gold,)))
            if not spans:
                bad += 1
                print(f"{case.id}: {gold} is not in the index")
    print(f"{len(ds.cases)} cases, {sum(len(c.gold) for c in ds.cases)} gold symbols, {bad} missing")
    return 1 if bad else 0


def cmd_retrieval(args: argparse.Namespace) -> int:
    ds = datasets.load(args.dataset)
    variants = list(runner.VARIANTS) if args.variants == "all" else args.variants.split(",")
    agent = runner.build_agent(ds, record=args.record, delay=args.delay)
    run = {"meta": runner.meta(ds, "retrieval"), "retrieval": runner.run_retrieval(agent, ds, variants, args.limit)}
    recorded = agent.query_planner.recorded
    if recorded:
        print(f"Recorded {recorded} new plans in {agent.query_planner.path}", file=sys.stderr)
    _write(run, _out_path(args, "retrieval"), args.baseline)
    return 0


def cmd_answers(args: argparse.Namespace) -> int:
    ds = datasets.load(args.dataset)
    agent = runner.build_agent(ds, record=True, delay=args.delay)
    out = _out_path(args, "answers")
    raw_path = Path(args.resume) if args.resume else out.with_suffix(".jsonl")
    raw = runner.run_answers(
        agent, ds, raw_path, limit=args.limit, delay=args.delay, allow_followup=not args.no_followup
    )
    run = {"meta": {**runner.meta(ds, "answers"), "raw": str(raw_path)}, "answers": runner.score_answers(ds, raw)}
    _write(run, out, args.baseline)
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    run = json.loads(Path(args.run).read_text())
    base = json.loads(Path(args.baseline).read_text()) if args.baseline else None
    print(report.markdown(run, base))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m eval", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def with_dataset(p: argparse.ArgumentParser) -> argparse.ArgumentParser:
        p.add_argument("--dataset", default="click", help="name in eval/datasets/ or a .toml path")
        p.add_argument("--limit", type=int, help="only the first N cases")
        p.add_argument("--out", help="where to save the run (default: eval/results/...)")
        p.add_argument("--baseline", help="a saved run to compare against")
        return p

    with_dataset(sub.add_parser("check", help="every gold symbol exists in the index")).set_defaults(fn=cmd_check)

    p = with_dataset(sub.add_parser("retrieval", help="retrieval metrics per stage and ablation"))
    p.add_argument("--variants", default="all", help=f"comma-separated, or 'all': {', '.join(runner.VARIANTS)}")
    p.add_argument("--record", action="store_true", help="call the planner for questions with no recorded plan")
    p.add_argument("--delay", type=float, default=4.0, help="seconds between planner calls while recording")
    p.set_defaults(fn=cmd_retrieval)

    p = with_dataset(sub.add_parser("answers", help="ask every question and score the answers"))
    p.add_argument("--delay", type=float, default=6.0, help="seconds between questions (rate limits)")
    p.add_argument("--no-followup", action="store_true", help="don't let the model ask for more code")
    p.add_argument("--resume", help="a .jsonl from an interrupted run: skip the cases already in it")
    p.set_defaults(fn=cmd_answers)

    p = sub.add_parser("report", help="print the summary of a saved run")
    p.add_argument("run")
    p.add_argument("--baseline")
    p.set_defaults(fn=cmd_report)

    args = parser.parse_args(argv)
    # The pipeline logs every step; only the harness's own progress is shown.
    logging.basicConfig(level=logging.WARNING, format="%(message)s")
    logging.getLogger("eval").setLevel(logging.INFO)
    return int(args.fn(args))


if __name__ == "__main__":
    raise SystemExit(main())
