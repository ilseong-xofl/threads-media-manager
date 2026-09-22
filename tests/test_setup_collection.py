"""Standard-library tests; every write is isolated in TemporaryDirectory."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from xml.sax.saxutils import escape
import zipfile


SCRIPT = Path(__file__).resolve().parents[1] / "plugins/threads-collector/scripts/setup_collection.py"
SPEC = importlib.util.spec_from_file_location("setup_collection", SCRIPT)
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)


def make_workbook(path, *, mode="str", bad_version=False, formula=False, header_layout=None, formula_header=False):
    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    cells = {"A3": "형식 버전", "B3": "broken" if bad_version else "daily-v1"}
    def column_name(index):
        result = ""
        while index:
            index, remainder = divmod(index - 1, 26)
            result = chr(65 + remainder) + result
        return result
    cells.update({f"{column_name(i+1)}6": v for i, v in enumerate(setup.HEADERS if header_layout is None else header_layout)})
    # Deliberately use another first sheet and shuffled cell order to exercise
    # relationship and cell-address lookup, not filename/order assumptions.
    entries = list(reversed(list(cells.items())))
    fragments = []
    strings = []
    for ref, value in entries:
        if mode == "shared":
            strings.append(value)
            child, kind = f"<v>{len(strings)-1}</v>", "s"
        elif mode == "inline":
            child, kind = f"<is><t>{escape(value)}</t></is>", "inlineStr"
        else:
            child, kind = f"<v>{escape(value)}</v>", "str"
        if (formula and ref == "B3") or (formula_header and ref == "A6"):
            child = "<f>1+1</f>" + child
        fragments.append(f'<c r="{ref}" t="{kind}">{child}</c>')
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("xl/workbook.xml", f'<workbook xmlns="{ns}" xmlns:r="{rel}"><sheets><sheet name="설명" r:id="other"/><sheet name="계정" r:id="accounts"/></sheets></workbook>')
        archive.writestr("xl/_rels/workbook.xml.rels", f'<Relationships><Relationship Id="other" Type="{rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="accounts" Type="{rel}/worksheet" Target="/xl/worksheets/sheet7.xml"/></Relationships>')
        archive.writestr("xl/worksheets/sheet1.xml", f'<worksheet xmlns="{ns}"/>')
        archive.writestr("xl/worksheets/sheet7.xml", f'<worksheet xmlns="{ns}"><sheetData><row>{"".join(fragments)}</row></sheetData></worksheet>')
        if mode == "shared":
            archive.writestr("xl/sharedStrings.xml", f'<sst xmlns="{ns}">' + "".join(f"<si><t>{escape(v)}</t></si>" for v in strings) + "</sst>")


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="threads-setup-test-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.root = self.base / "자료 한글 공백" / "collection"
        self.config = self.base / "설정 공백" / "settings.json"
        self.template = self.base / "template.xlsx"
        make_workbook(self.template)

    def init(self, root=None):
        return setup.initialize(str(self.config), str(root or self.root), self.template)

    def expect_error(self, code, action):
        with self.assertRaises(setup.SetupError) as caught:
            action()
        self.assertEqual(code, caught.exception.code)

    def snapshot(self):
        return {str(p.relative_to(self.base)): (p.read_bytes(), p.stat().st_mtime_ns)
                for p in self.base.rglob("*") if p.is_file()}

    def test_status_unconfigured_makes_no_files(self):
        before = self.snapshot()
        result = setup.status(str(self.config))
        self.assertFalse(result["configured"])
        self.assertEqual("not_configured", result["setup_state"])
        self.assertEqual(before, self.snapshot())
        self.assertFalse(self.config.parent.exists())

    def test_initial_creation_and_repeat_are_idempotent(self):
        result = self.init()
        self.assertEqual("prepared", result["setup_state"])
        self.assertFalse(result["login_checked"])
        self.assertEqual(self.template.read_bytes(), (self.root / "accounts.xlsx").read_bytes())
        before = self.snapshot()
        self.assertEqual("prepared", self.init()["setup_state"])
        self.assertEqual(before, self.snapshot())
        self.assertEqual([], list(self.root.rglob("*.lock")))

    def test_existing_accounts_preserved_with_real_cell_address_lookup(self):
        for mode in ("str", "shared", "inline"):
            with self.subTest(mode=mode):
                root = self.base / mode
                accounts = root / "accounts.xlsx"
                make_workbook(accounts, mode=mode)
                original = accounts.read_bytes()
                config = self.base / f"{mode}.json"
                setup.initialize(str(config), str(root), self.template)
                self.assertEqual(original, accounts.read_bytes())

    def test_readonly_status_does_not_change_files(self):
        self.init()
        before = self.snapshot()
        self.assertEqual("prepared", setup.status(str(self.config))["setup_state"])
        self.assertEqual(before, self.snapshot())

    def test_new_root_rejected_before_it_is_created(self):
        self.init()
        before = self.snapshot()
        other = self.base / "other"
        self.expect_error("root_change_unsupported", lambda: self.init(other))
        self.assertFalse(other.exists())
        self.assertEqual(before, self.snapshot())

    def test_corrupt_and_unknown_settings_never_replaced(self):
        self.config.parent.mkdir()
        for content in (b'{"schema_version":', b'{"schema_version":2,"collection_root":"/tmp/x"}', b'[]'):
            with self.subTest(content=content):
                self.config.write_bytes(content)
                self.expect_error("invalid_settings", self.init)
                self.assertEqual(content, self.config.read_bytes())
                self.assertFalse(self.root.exists())

    def test_corrupt_accounts_preserved_and_config_not_written(self):
        accounts = self.root / "accounts.xlsx"
        self.root.mkdir(parents=True)
        for content in (b"truncated zip", b""):
            accounts.write_bytes(content)
            self.expect_error("invalid_accounts", self.init)
            self.assertEqual(content, accounts.read_bytes())
            self.assertFalse(self.config.exists())

    def test_bad_version_and_formula_rejected(self):
        for kwargs in ({"bad_version": True}, {"formula": True}):
            with self.subTest(kwargs=kwargs):
                make_workbook(self.root / "accounts.xlsx", **kwargs)
                self.expect_error("invalid_accounts", self.init)
                self.assertFalse(self.config.exists())

    def test_reordered_headers_and_additional_columns_are_preserved(self):
        accounts = self.root / "accounts.xlsx"
        # Required columns deliberately start after Z, including reordered names.
        layout = [f"사용자 열 {i}" for i in range(28)] + list(reversed(setup.HEADERS))
        make_workbook(accounts, mode="shared", header_layout=layout)
        original = accounts.read_bytes()
        self.assertEqual("prepared", self.init()["setup_state"])
        self.assertEqual(original, accounts.read_bytes())

    def test_missing_duplicate_and_formula_required_headers_rejected(self):
        cases = [
            {"header_layout": list(setup.HEADERS[:-1])},
            {"header_layout": [*setup.HEADERS, setup.HEADERS[0]]},
            {"formula_header": True},
        ]
        for kwargs in cases:
            with self.subTest(kwargs=kwargs):
                accounts = self.root / "accounts.xlsx"
                make_workbook(accounts, **kwargs)
                original = accounts.read_bytes()
                self.expect_error("invalid_accounts", self.init)
                self.assertEqual(original, accounts.read_bytes())
                self.assertFalse(self.config.exists())

    def test_init_does_not_claim_prepared_after_final_state_changes(self):
        for state in ("busy", "incomplete"):
            with self.subTest(state=state):
                final_status = {"ok": True, "operation": "status", "setup_state": state,
                                "blocking_markers": ["another-run.lock"] if state == "busy" else []}
                with mock.patch.object(setup, "status", return_value=final_status):
                    result = self.init()
                self.assertFalse(result["ok"])
                self.assertEqual("init", result["operation"])
                self.assertNotIn("message", result)
                self.assertEqual("setup_not_prepared", result["error"]["code"])

    def test_collector_lock_and_excel_markers_block(self):
        for relative in ("_work/collector.lock", "~$accounts.xlsx", ".~lock.accounts.xlsx#"):
            with self.subTest(relative=relative):
                self.root.mkdir(parents=True, exist_ok=True)
                make_workbook(self.root / "accounts.xlsx")
                marker = self.root / relative
                marker.parent.mkdir(exist_ok=True)
                marker.write_text("in use")
                self.expect_error("busy", self.init)
                self.assertEqual("in use", marker.read_text())
                marker.unlink()

    def test_concurrent_init_lock_blocks_without_deleting_it(self):
        self.config.parent.mkdir()
        lock = self.config.with_name(self.config.name + ".init.lock")
        with setup.exclusive_lock(lock):
            self.expect_error("busy", self.init)
            self.assertTrue(lock.exists())
        self.assertFalse(self.root.exists())

    def test_directory_collision_is_not_replaced(self):
        self.root.mkdir(parents=True)
        blocker = self.root / "results"
        blocker.write_text("retain me")
        self.expect_error("path_collision", self.init)
        self.assertEqual("retain me", blocker.read_text())
        self.assertFalse((self.root / "accounts.xlsx").exists())

    def test_existing_history_without_accounts_requires_recovery(self):
        history = self.root / "results" / "old.xlsx"
        history.parent.mkdir(parents=True)
        history.write_bytes(b"history")
        self.expect_error("recovery_required", self.init)
        self.assertFalse((self.root / "accounts.xlsx").exists())
        self.assertFalse(self.config.exists())

    def test_registered_missing_accounts_or_root_not_recreated(self):
        self.init()
        (self.root / "accounts.xlsx").unlink()
        before = self.snapshot()
        self.expect_error("recovery_required", self.init)
        result = setup.status(str(self.config))
        self.assertFalse(result["ok"])
        self.assertFalse(result["accounts_exists"])
        self.assertEqual("recovery_required", result["setup_state"])
        self.assertEqual(before, self.snapshot())
        for name in setup.STORAGE_DIRS:
            (self.root / name).rmdir()
        self.root.rmdir()
        self.expect_error("recovery_required", self.init)
        self.assertFalse(self.root.exists())

    def test_atomic_publication_failure_preserves_account_and_allows_resume(self):
        real_link = setup.os.link
        def fail_settings(source, destination):
            if Path(destination) == self.config:
                raise PermissionError("simulated settings permission failure")
            return real_link(source, destination)
        with mock.patch.object(setup.os, "link", side_effect=fail_settings):
            with self.assertRaises(PermissionError):
                self.init()
        accounts = self.root / "accounts.xlsx"
        self.assertEqual(self.template.read_bytes(), accounts.read_bytes())
        self.assertFalse(self.config.exists())
        self.assertEqual([], list(self.base.rglob(".threads-setup-*")))
        original = accounts.read_bytes()
        self.assertEqual("prepared", self.init()["setup_state"])
        self.assertEqual(original, accounts.read_bytes())

    def test_no_clobber_if_settings_appears_during_publish(self):
        def concurrent(source, destination):
            Path(destination).write_bytes(b"other writer")
            raise FileExistsError("simulated competing writer")
        path = self.base / "existing.json"
        with mock.patch.object(setup.os, "link", side_effect=concurrent):
            self.expect_error("concurrent_change", lambda: setup.publish_new_file(path, b"new", lambda p: None))
        self.assertEqual(b"other writer", path.read_bytes())

    def test_plugin_and_cache_roots_and_relative_paths_rejected(self):
        for root, code in (("relative", "absolute_path_required"),
                           (str(setup.PLUGIN_ROOT / "data"), "plugin_storage_forbidden"),
                           (str(self.base / ".codex/plugins/cache/p/v/data"), "plugin_storage_forbidden")):
            with self.subTest(root=root):
                self.expect_error(code, lambda: setup.initialize(str(self.config), root, self.template))

    def test_other_plugin_source_ancestor_is_not_user_storage(self):
        source = self.base / "another checkout" / "plugins" / "collector"
        manifest = source / ".codex-plugin/plugin.json"
        manifest.parent.mkdir(parents=True)
        manifest.write_text('{"name":"other-collector"}')
        for selected in (source, source / "nested/user data"):
            with self.subTest(selected=selected):
                self.expect_error("plugin_storage_forbidden", lambda: self.init(selected))
                self.assertFalse(self.config.exists())
        self.assertFalse((source / "nested").exists())

    def test_symlink_accounts_is_not_followed_or_modified(self):
        self.root.mkdir(parents=True)
        try:
            (self.root / "accounts.xlsx").symlink_to(self.template)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        before = self.template.read_bytes()
        self.expect_error("invalid_accounts", self.init)
        self.assertEqual(before, self.template.read_bytes())

    def test_filesystem_failure_emits_json_nonzero(self):
        with mock.patch.object(setup, "initialize", side_effect=PermissionError("simulated denied")):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = setup.main(["init", "--collection-root", str(self.root), "--config-path", str(self.config)])
        self.assertEqual(2, code)
        self.assertEqual("filesystem_error", json.loads(output.getvalue())["error"]["code"])

    def test_cli_config_argument_both_positions_is_isolated(self):
        for args in (["status", "--config-path", str(self.config)], ["--config-path", str(self.config), "status"]):
            with self.subTest(args=args):
                completed = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, check=False)
                self.assertEqual(0, completed.returncode, completed.stderr)
                self.assertEqual(str(self.config), json.loads(completed.stdout)["config_path"])
                self.assertFalse(self.config.parent.exists())

    def test_cli_json_supports_unicode_paths_with_ascii_stdout(self):
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), "status", "--config-path", str(self.config)],
            capture_output=True, check=False,
            env=dict(os.environ, PYTHONIOENCODING="ascii"),
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertEqual(str(self.config), json.loads(completed.stdout)["config_path"])
        self.assertFalse(self.config.parent.exists())


if __name__ == "__main__":
    unittest.main()
