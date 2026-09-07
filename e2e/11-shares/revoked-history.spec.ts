import { expect, test } from '../fixtures/app'
import { secondCredentials } from '../setup/credentials'
import { createObjectWithId } from '../utils/process'

/**
 * S9 — who USED to have access, and the rule that decides when they stop being listed.
 *
 * `73ec00d` added the history and, with it, the reason the list is keyed by (subject, SOURCE)
 * rather than by subject: someone can hold a live Share-sourced grant while their old ad-hoc one
 * sits revoked, and those are two real rows. The projection's guard is `if (live.has(key)) continue`
 * — a live grant from the SAME source hides its own revoked row, and only that one.
 *
 * So the case is both halves of that guard on one subject: revoke and they appear in the history;
 * restore and they leave it, because the live direct grant now covers the same key. A history that
 * kept listing a person who is sitting in the members list above is the failure `73ec00d`'s message
 * names, and it is the one a count-only assertion would miss.
 *
 * No session switch: account 2 is only ever a SUBJECT here, never signed in, so this file owes no
 * `restoreSession`.
 */

const second = secondCredentials()

test.describe('11 - shares / revoked history', () => {
  test.skip(
    !second,
    'set E2E_EMAIL_2 and E2E_PASSWORD_2 in .env.local — a revoked grant needs a grantee'
  )

  test('S9: a revoke joins the history, and a restore leaves it', async ({
    page,
  }) => {
    const objectName = `e2e-${Date.now()}-s9`
    await createObjectWithId(page, objectName)

    await page.goto('/objects')
    const row = page
      .getByTestId('data-table-row')
      .filter({ hasText: objectName })
      .first()
    await expect(row).toBeVisible()

    const openShare = async () => {
      await row.getByTestId('object-actions-dropdown').click()
      await page.getByTestId('object-action-share').click()
      // The people-picker popover is ALSO `role="dialog"`, so the sheet is named rather than taken
      // as the only one.
      const panel = page.getByRole('dialog', { name: /share/i })
      await expect(panel).toBeVisible()
      return panel
    }

    let panel = await openShare()

    // The picker searches the SERVER (`shouldFilter={false}`), so an empty box offers nobody.
    await page.getByTestId('share-add-people').click()
    await page.getByPlaceholder(/search/i).fill(second!.email)
    const option = page.getByRole('option').first()
    await expect(option).toBeVisible({ timeout: 15_000 })
    await option.click()

    // The draft key is minted by the sheet, so it is read off the DOM rather than guessed — and it
    // is the same key the revoked rows are addressed by (`keyOf(grant.subject)`).
    const member = panel.locator('[data-testid^="share-member-"]').first()
    const subjectId = (await member.getAttribute('data-testid'))!.replace(
      'share-member-',
      ''
    )

    await page.getByTestId('share-sheet-save').click()
    await expect(panel).toBeHidden()

    // Nobody has been revoked yet, so the section must not exist at all — a history that renders
    // empty would make every assertion below pass on the wrong grant.
    panel = await openShare()
    await expect(page.getByTestId('revoked-toggle')).toHaveCount(0)

    await page.getByTestId(`share-member-remove-${subjectId}`).click()
    await page.getByTestId('share-sheet-save').click()
    await expect(panel).toBeHidden()

    // REOPENED, so the history is read back from the node rather than from the draft that was just
    // on screen — the sheet drops the row locally the moment you click.
    panel = await openShare()
    const toggle = page.getByTestId('revoked-toggle')
    await expect(toggle).toBeVisible()
    await expect(page.getByTestId('revoked-count')).toHaveText('1')

    // Collapsed by default: the rows do not exist until it is opened.
    await expect(page.getByTestId(`revoked-row-${subjectId}`)).toHaveCount(0)
    await toggle.click()
    const revokedRow = page.getByTestId(`revoked-row-${subjectId}`)
    await expect(revokedRow).toBeVisible()
    // The PERMISSION they last held. `73ec00d`'s own hint says the projection keeps who and the
    // last permission, never the permission at revoke time, so this is the whole of what the row
    // promises. Identity is already carried by the testid — it is `keyOf(grant.subject)`, read off
    // the member row before the revoke, so a history listing the wrong person finds no element.
    await expect(revokedRow).toContainText(/read/i)

    // Restore writes IMMEDIATELY — it calls the grant mutation and then `onDone()`, unlike every
    // other edit in this sheet, which is staged into the draft and committed by Save. Clicking Save
    // after it waits forever on a button that was never going to enable.
    await page.getByTestId(`revoked-restore-${subjectId}`).click()
    await expect(panel).toBeHidden()

    // Both halves of `if (live.has(key)) continue`, read back from the node: they are a member
    // again, AND they are no longer former. Asserting only the first would pass on a history that
    // lists someone who currently has access.
    await openShare()
    await expect(page.getByTestId(`share-member-${subjectId}`)).toBeVisible()
    await expect(page.getByTestId('revoked-toggle')).toHaveCount(0)
  })
})
