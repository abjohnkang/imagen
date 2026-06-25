"""Unit tests for db._where — the shared gallery-filter clause builder.

Run from the repo root with:  python3 -m unittest tests.test_where
Uses only the standard library, so no install is needed.
"""
import unittest

from app.db import _where


class WhereTests(unittest.TestCase):
    def test_no_filters_is_empty(self):
        # No favorites filter and no query -> no WHERE clause, no params.
        clause, params = _where(False, "")
        self.assertEqual(clause, "")
        self.assertEqual(params, [])

    def test_favorites_only(self):
        clause, params = _where(True, "")
        self.assertEqual(clause, " WHERE favorite = 1")
        self.assertEqual(params, [])

    def test_query_only(self):
        clause, params = _where(False, "cat")
        self.assertEqual(clause, " WHERE prompt LIKE ? ESCAPE '\\'")
        self.assertEqual(params, ["%cat%"])

    def test_both_filters_are_anded(self):
        clause, params = _where(True, "cat")
        self.assertEqual(
            clause, " WHERE favorite = 1 AND prompt LIKE ? ESCAPE '\\'"
        )
        self.assertEqual(params, ["%cat%"])

    def test_percent_is_escaped_literally(self):
        # "%" is a LIKE wildcard; it must be escaped so searching "50%" matches
        # the literal text, not "50 followed by anything".
        _, params = _where(False, "50%")
        self.assertEqual(params, ["%50\\%%"])

    def test_underscore_is_escaped_literally(self):
        # "_" is the single-character LIKE wildcard; "a_b" must not match "aXb".
        _, params = _where(False, "a_b")
        self.assertEqual(params, ["%a\\_b%"])

    def test_backslash_is_doubled_first(self):
        # A literal backslash in the query is doubled so it stays literal under
        # ESCAPE '\'. This pass runs first, so the backslashes added when
        # escaping % and _ are not themselves re-doubled.
        _, params = _where(False, "a\\b")
        self.assertEqual(params, ["%a\\\\b%"])

    def test_combined_special_characters(self):
        # All three special characters together, exercising the ordering: the
        # backslash is doubled, then % and _ each gain a single escape backslash.
        _, params = _where(False, "\\%_")
        self.assertEqual(params, ["%\\\\\\%\\_%"])


if __name__ == "__main__":
    unittest.main()
