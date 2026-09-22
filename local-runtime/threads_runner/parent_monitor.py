"""Fail-closed parent liveness monitoring without network or process spawning.

POSIX reparents an orphan, so the saved parent PID is sufficient there. Windows
keeps the original PID: hold a SYNCHRONIZE process handle instead, and verify its
creation time against the child to reject a PID reused before initialization.
Windows API failures prevent initialization; later failures cancel the transfer.
"""
from __future__ import annotations

import os
import threading


class MonitorError(ValueError):
    """Safe, fixed diagnostic suitable for the command's JSON error response."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


_WAIT_OBJECT_0 = 0
_WAIT_TIMEOUT = 258
_SYNCHRONIZE = 0x00100000
_QUERY_LIMITED_INFORMATION = 0x00001000


def _is_windows() -> bool:
    return os.name == "nt"


class _WindowsKernel:
    """Small injectable adapter; ctypes/Windows bindings load only on Windows."""

    def __init__(self):
        import ctypes
        from ctypes import wintypes

        self.ctypes = ctypes
        self.filetime = wintypes.FILETIME
        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        self.api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.api.OpenProcess.restype = wintypes.HANDLE
        self.api.GetCurrentProcess.argtypes = []
        self.api.GetCurrentProcess.restype = wintypes.HANDLE
        self.api.GetProcessTimes.argtypes = [wintypes.HANDLE, *([ctypes.POINTER(wintypes.FILETIME)] * 4)]
        self.api.GetProcessTimes.restype = wintypes.BOOL
        self.api.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        self.api.WaitForSingleObject.restype = wintypes.DWORD
        self.api.CloseHandle.argtypes = [wintypes.HANDLE]
        self.api.CloseHandle.restype = wintypes.BOOL

    def open_process(self, pid: int):
        return self.api.OpenProcess(_SYNCHRONIZE | _QUERY_LIMITED_INFORMATION, False, pid)

    def current_process(self):
        return self.api.GetCurrentProcess()  # Borrowed pseudo-handle; never close.

    def creation_time(self, handle) -> int:
        creation, exit_time, kernel, user = (self.filetime() for _ in range(4))
        if not self.api.GetProcessTimes(handle, *(self.ctypes.byref(value)
                                                for value in (creation, exit_time, kernel, user))):
            raise MonitorError("parent_monitor_unavailable", "부모 프로세스의 생성 시각을 확인할 수 없습니다.")
        return (creation.dwHighDateTime << 32) | creation.dwLowDateTime

    def wait(self, handle) -> int:
        return self.api.WaitForSingleObject(handle, 0)

    def close(self, handle) -> None:
        self.api.CloseHandle(handle)


def _windows_kernel():
    return _WindowsKernel()


class ParentMonitor:
    """Monitor the current parent until close(); cancellation remains sticky.

    Construct before any network work. ``cancelled`` never propagates OS/API
    errors: inability to establish liveness is cancellation. ``close`` owns only
    the opened parent handle, is idempotent, and makes further checks cancel.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._closed = False
        self._cancelled = False
        self._kernel = None
        self._handle = None
        try:
            self._parent_pid = os.getppid()
            if type(self._parent_pid) is not int or self._parent_pid <= 1:
                raise MonitorError("parent_exited", "부모 프로세스가 없어 전송을 시작할 수 없습니다.")
            if _is_windows():
                self._kernel = _windows_kernel()
                self._handle = self._kernel.open_process(self._parent_pid)
                if not self._handle:
                    raise MonitorError("parent_monitor_unavailable", "부모 프로세스 감시 핸들을 열 수 없습니다.")
                parent_created = self._kernel.creation_time(self._handle)
                child_created = self._kernel.creation_time(self._kernel.current_process())
                if parent_created <= 0 or child_created <= 0 or parent_created > child_created:
                    raise MonitorError("parent_identity_changed", "부모 프로세스의 신원을 확인할 수 없습니다.")
                state = self._kernel.wait(self._handle)
                if state == _WAIT_OBJECT_0:
                    raise MonitorError("parent_exited", "부모 프로세스가 종료되어 전송을 시작할 수 없습니다.")
                if state != _WAIT_TIMEOUT:
                    raise MonitorError("parent_monitor_unavailable", "부모 프로세스의 실행 상태를 확인할 수 없습니다.")
            elif os.getppid() != self._parent_pid:
                raise MonitorError("parent_exited", "부모 프로세스가 종료되어 전송을 시작할 수 없습니다.")
        except MonitorError:
            self.close()
            raise
        except Exception:
            self.close()
            raise MonitorError("parent_monitor_unavailable", "부모 프로세스 감시를 시작할 수 없습니다.") from None

    def cancelled(self) -> bool:
        with self._lock:
            if self._closed or self._cancelled:
                return True
            try:
                if self._kernel is None:
                    self._cancelled = os.getppid() != self._parent_pid
                else:
                    # A retained handle names the original process, even if its
                    # numeric PID has since been reused by a different process.
                    self._cancelled = self._kernel.wait(self._handle) != _WAIT_TIMEOUT
            except Exception:
                self._cancelled = True
            return self._cancelled

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            handle, self._handle = self._handle, None
            if handle and self._kernel is not None:
                try:
                    self._kernel.close(handle)
                except Exception:
                    # Cleanup must not replace the original safe transfer error.
                    pass
