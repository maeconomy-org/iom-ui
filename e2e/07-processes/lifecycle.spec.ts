import type { Page } from '@playwright/test'

import { expect, test } from '../fixtures/app'
import {
  createObjectWithId,
  createProcess,
  openProcess,
  processRow,
} from '../utils/process'
import { enterEditMode, saveSheet, sheet } from '../utils/sheet'
import { selectView } from '../utils/views'

/**
 * PR1 — the four verbs the list offers, end to end on one process.
 *
 * `list.read.spec.ts` has PR1a (rows render) and PR1b (the create sheet opens and cancels), which
 * between them never write a process. So the row actions this page mounts had no case at all, and
 * the menu SWAP is the part that matters: `process-columns.tsx` guards delete at `admin` rather
 * than `write`, and replaces the whole action list with a lone Restore once the row is deleted — so
 * a row that came back with the wrong menu looks identical to one that came back right.
 *
 * Soft delete, like everywhere else (D85): the row is hidden, not gone. The `deleted` filter is
 * what proves the difference, and it is also what makes Restore reachable.
 */

const stamp = () => `e2e-${Date.now()}`

async function toggleDeleted(page: Page): Promise<void> {
  await page.getByTestId('filter-menu').click()
  await page.getByTestId('filter-option-deleted').click()
  await page.keyboard.press('Escape')
}

test.describe('07 - processes / list lifecycle', () => {
  test('PR1: a process is created, renamed, deleted and restored from the list', async ({
    page,
  }) => {
    const tag = stamp()
    const inputName = `${tag}-in`
    // Disjoint strings, not a prefix and its extension: the "old name is gone" assertion filters
    // rows by text, and `-renamed` would still contain the original.
    const original = `${tag}-pr1-before`
    const renamed = `${tag}-pr1-after`

    await createObjectWithId(page, inputName)
    await createProcess(page, original, [inputName], inputName)

    // The filter menu renders only in table view (PR2), and the view is an account preference a
    // previous run may have left on the flow. Set it rather than assume it.
    await selectView(page, 'table')
    await expect(processRow(page, original)).toHaveCount(1)

    // Details then Edit, NOT the row's Edit action — that action opens a sheet whose Details fields
    // are dead, which is PR1c below.
    await openProcess(page, original)
    await enterEditMode(page)
    const panel = sheet(page)
    const nameField = panel.getByLabel(/name/i).first()
    await expect(nameField).toHaveValue(original)
    await nameField.fill(renamed)
    await saveSheet(page)

    // The new name in the LIST, and the old one gone from it — a rename that only updated the sheet
    // would satisfy the first assertion on a stale row.
    await page.reload()
    await expect(processRow(page, renamed)).toHaveCount(1)
    await expect(
      page.getByTestId('data-table-row').filter({ hasText: original })
    ).toHaveCount(0)

    await processRow(page, renamed)
      .getByTestId('process-actions-dropdown')
      .click()
    await page.getByTestId('process-action-delete').click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: /delete/i })
      .click()
    await expect(
      page.getByTestId('data-table-row').filter({ hasText: renamed })
    ).toHaveCount(0)

    // SOFT: still there behind the filter.
    await toggleDeleted(page)
    const deleted = processRow(page, renamed)
    await expect(deleted).toHaveCount(1)

    // And its menu is Restore ALONE. `rowActions` swaps the list wholesale for a deleted row, so an
    // Edit or a second Delete offered here would be a control the node refuses.
    await deleted.getByTestId('process-actions-dropdown').click()
    await expect(page.getByTestId('process-action-restore')).toBeVisible()
    await expect(page.getByTestId('process-action-edit')).toHaveCount(0)
    await expect(page.getByTestId('process-action-delete')).toHaveCount(0)

    await page.getByTestId('process-action-restore').click()

    // Back among the LIVE rows, which is the claim — with the deleted filter still on, a row that
    // never restored is still visible and indistinguishable from one that did.
    await toggleDeleted(page)
    await expect(processRow(page, renamed)).toHaveCount(1)
  })

  /**
   * PR1c — ⏸ CHARACTERISES A LIVE BUG. See `docs/e2e-docs/e2e-run-2026-08-31.md` "Still open" #7.
   *
   * The row's **Edit** action opens the sheet with `initialEditing`, before the fetch resolves. The
   * Details fields mount against a form instance that is then replaced, so they keep refs into the
   * dead one: Name renders blank while the header, the flows and the read view all show the real
   * name, and typing into Name or Description dirties nothing — Save never enables. Switching tabs
   * and back remounts the fields against the live form and everything works.
   *
   * Measured, both paths, same process, same run: via the Edit action the field read `""` after 10
   * seconds and Save stayed disabled after typing a description; via Details → Edit it read the
   * name immediately. Every other process spec uses the second path, which is why this survived.
   *
   * It asserts the BROKEN behaviour rather than wearing `test.fail`, and the difference matters.
   * `test.fail` is satisfied by any failure, including `createProcess` timing out on a cold node —
   * so it would report PASSING while never reaching the bug, and rot exactly the way `.fixme`
   * would. Written this way the case still goes red the day the sheet is fixed, and it also goes
   * red if its own fixture breaks. Delete it with the fix.
   */
  test('PR1c: the row Edit action still opens a dead form', async ({
    page,
  }) => {
    const tag = stamp()
    const inputName = `${tag}-in`
    const name = `${tag}-pr1c`

    await createObjectWithId(page, inputName)
    await createProcess(page, name, [inputName], inputName)
    await selectView(page, 'table')

    await processRow(page, name).getByTestId('process-actions-dropdown').click()
    await page.getByTestId('process-action-edit').click()
    await expect(sheet(page)).toBeVisible()

    // The header has the name; the form does not. Both asserted, so the case cannot pass on a sheet
    // that failed to open — which is the whole reason it is not a `test.fail`.
    await expect(sheet(page)).toContainText(name)
    await expect(page.locator('#entity-name')).toHaveValue('')

    // And the fields are dead. This is the half that costs a user their edit: they type, nothing
    // dirties, and Save stays greyed out with no explanation.
    await page.locator('#entity-description').fill(`${name}-desc`)
    await expect(page.getByTestId('sheet-save')).toBeDisabled()
  })
})
