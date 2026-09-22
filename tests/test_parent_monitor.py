"""Parent monitor behavior using fake Windows APIs; no Windows runtime claim."""
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "local-runtime/threads_runner/parent_monitor.py"
SPEC = importlib.util.spec_from_file_location("parent_monitor_tests_module", SCRIPT)
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)


class FakeKernel:
    def __init__(self):
        self.handle = 123
        self.opened = []
        self.closed = []
        self.times = {123: 100, -1: 200}
        self.wait_state = m._WAIT_TIMEOUT
        self.waited = []

    def open_process(self, pid):
        self.opened.append(pid)
        return self.handle

    def current_process(self):
        return -1

    def creation_time(self, handle):
        return self.times[handle]

    def wait(self, handle):
        self.waited.append(handle)
        return self.wait_state

    def close(self, handle):
        self.closed.append(handle)


class ParentMonitorTests(unittest.TestCase):
    def setUp(self):
        self.pid_patch = mock.patch.object(m.os, "getppid", return_value=42)
        self.getppid = self.pid_patch.start()
        self.addCleanup(self.pid_patch.stop)
        self.platform_patch = mock.patch.object(m, "_is_windows", return_value=False)
        self.is_windows = self.platform_patch.start()
        self.addCleanup(self.platform_patch.stop)
        self.kernel = FakeKernel()
        self.kernel_patch = mock.patch.object(m, "_windows_kernel", return_value=self.kernel)
        self.factory = self.kernel_patch.start()
        self.addCleanup(self.kernel_patch.stop)

    def windows(self):
        self.is_windows.return_value = True
        return m.ParentMonitor()

    def test_posix_reparenting_cancels_and_stays_cancelled(self):
        monitor = m.ParentMonitor()
        self.assertFalse(monitor.cancelled())
        self.getppid.return_value = 1
        self.assertTrue(monitor.cancelled())
        self.getppid.return_value = 42
        self.assertTrue(monitor.cancelled())
        self.factory.assert_not_called()

    def test_posix_orphan_initialization_rejected(self):
        self.getppid.return_value = 1
        with self.assertRaises(m.MonitorError) as caught:
            m.ParentMonitor()
        self.assertEqual(caught.exception.code, "parent_exited")

    def test_posix_reparenting_during_initialization_rejected(self):
        self.getppid.side_effect = [42, 1]
        with self.assertRaises(m.MonitorError):
            m.ParentMonitor()

    def test_monitor_initialization_error_is_safe(self):
        self.getppid.side_effect = OSError("sensitive OS diagnostic")
        with self.assertRaises(m.MonitorError) as caught:
            m.ParentMonitor()
        self.assertEqual(caught.exception.code, "parent_monitor_unavailable")
        self.assertNotIn("sensitive", str(caught.exception))

    def test_later_posix_check_error_cancels(self):
        monitor = m.ParentMonitor()
        self.getppid.side_effect = OSError("details")
        self.assertTrue(monitor.cancelled())

    def test_close_idempotent_and_further_checks_cancel(self):
        monitor = m.ParentMonitor()
        monitor.close()
        monitor.close()
        self.assertTrue(monitor.cancelled())

    def test_windows_retains_original_handle_and_detects_parent_exit(self):
        monitor = self.windows()
        self.assertEqual(self.kernel.opened, [42])
        self.assertFalse(monitor.cancelled())
        self.kernel.wait_state = m._WAIT_OBJECT_0
        self.assertTrue(monitor.cancelled())
        # Windows' constant parent PID does not affect handle-based liveness.
        self.assertEqual(self.getppid.call_count, 1)
        self.kernel.wait_state = m._WAIT_TIMEOUT
        self.assertTrue(monitor.cancelled())
        monitor.close()
        monitor.close()
        self.assertEqual(self.kernel.closed, [123])
        self.assertNotIn(-1, self.kernel.closed)

    def test_windows_cannot_open_handle_fails_preflight(self):
        self.kernel.handle = None
        with self.assertRaises(m.MonitorError) as caught:
            self.windows()
        self.assertEqual(caught.exception.code, "parent_monitor_unavailable")
        self.assertEqual(self.kernel.closed, [])

    def test_windows_pid_reused_after_child_started_is_rejected(self):
        self.kernel.times[123] = 300
        with self.assertRaises(m.MonitorError) as caught:
            self.windows()
        self.assertEqual(caught.exception.code, "parent_identity_changed")
        self.assertEqual(self.kernel.closed, [123])

    def test_windows_parent_already_exited_is_rejected(self):
        self.kernel.wait_state = m._WAIT_OBJECT_0
        with self.assertRaises(m.MonitorError) as caught:
            self.windows()
        self.assertEqual(caught.exception.code, "parent_exited")
        self.assertEqual(self.kernel.closed, [123])

    def test_windows_initial_api_failure_is_safe_and_closes_handle(self):
        self.kernel.creation_time = mock.Mock(side_effect=OSError("private process details"))
        with self.assertRaises(m.MonitorError) as caught:
            self.windows()
        self.assertEqual(caught.exception.code, "parent_monitor_unavailable")
        self.assertNotIn("private", str(caught.exception))
        self.assertEqual(self.kernel.closed, [123])

    def test_windows_initial_wait_failure_is_rejected(self):
        self.kernel.wait_state = 0xFFFFFFFF
        with self.assertRaises(m.MonitorError) as caught:
            self.windows()
        self.assertEqual(caught.exception.code, "parent_monitor_unavailable")
        self.assertEqual(self.kernel.closed, [123])

    def test_windows_later_wait_failure_cancels(self):
        monitor = self.windows()
        self.kernel.wait_state = 0xFFFFFFFF
        self.assertTrue(monitor.cancelled())
        monitor.close()

    def test_windows_later_api_exception_cancels(self):
        monitor = self.windows()
        self.kernel.wait = mock.Mock(side_effect=OSError("details"))
        self.assertTrue(monitor.cancelled())
        monitor.close()

    def test_windows_close_failure_does_not_replace_transfer_error(self):
        monitor = self.windows()
        self.kernel.close = mock.Mock(side_effect=OSError("details"))
        monitor.close()
        self.assertTrue(monitor.cancelled())


if __name__ == "__main__":
    unittest.main()
