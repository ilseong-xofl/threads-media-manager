#!/usr/bin/env python3
"""Shared download runner: Excel source, durable state, one-file pilot only."""
import argparse
import json
import os
from pathlib import Path
import signal
import sys

from threads_runner import runner
from threads_runner.state import StateError
from threads_runner.transport import TransferError
from threads_runner.parent_monitor import ParentMonitor, MonitorError


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collection-root",type=Path,required=True)
    sub=parser.add_subparsers(dest="command",required=True)
    sub.add_parser("inspect")
    sub.add_parser("status")
    sub.add_parser("recover")
    plan=sub.add_parser("plan-one")
    plan.add_argument("--account",required=True)
    get=sub.add_parser("download-one")
    get.add_argument("--job-id",required=True)
    args=parser.parse_args(argv)
    stopped=[False]
    monitor=None
    def stop(*_): stopped[0]=True
    for sig in (signal.SIGINT,signal.SIGTERM): signal.signal(sig,stop)
    cancel=lambda: stopped[0] or (monitor is not None and monitor.cancelled())
    try:
        monitor=ParentMonitor()
        root=args.collection_root
        if args.command=="inspect": result=runner.inspect_source(root)
        elif args.command=="plan-one": result=runner.plan_one(root,args.account)
        elif args.command=="download-one": result=runner.download_one(root,args.job_id,cancel=cancel)
        elif args.command=="recover": result=runner.recover(root)
        else: result=runner.status(root)
        print(json.dumps({"ok":True,**result},ensure_ascii=False))
        return 0
    except Exception as exc:
        safe=isinstance(exc,(StateError,TransferError,MonitorError)) or type(exc).__name__=="InputError"
        print(json.dumps({"ok":False,"error":{"code":getattr(exc,"code","runner_error"),
             "message":str(exc) if safe else "실행기가 중단되었습니다. 원본과 상태 파일을 보존했습니다."}},ensure_ascii=False))
        return 1
    finally:
        if monitor is not None: monitor.close()


if __name__=="__main__":
    sys.exit(main())
