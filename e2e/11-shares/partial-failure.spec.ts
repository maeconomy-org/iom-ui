import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Page } from '@playwright/test'

import { expect, test } from '../fixtures/app'
import { secondCredentials } from '../setup/credentials'
import { createObjectWithId } from '../utils/process'

/**
 * S13 — one failed grant does not cancel the revokes beside it.
 *
 * `2fa9981` was bought by a real report ("I can't revoke one user from this share"). Every edit used
 * to run in ONE `try` with grants first, so a single failing grant — on an unrelated member —
 * aborted the loop before any revoke ran, and which edits survived depended on member ORDER, which
 * the user cannot see. The fix runs revokes first and gives each edit its own `try`.
 *
 * THE FAILURE IS INJECTED ON ONE REQUEST, NOT ALL OF THEM. `POST /v1/access/grant` and
 * `POST /v1/access/revoke` are separate paths, so refusing only the grant leaves the success path
 * observable — and that is the whole contract: the revoke landed, the grant did not. Refusing
 * everything would make "one request fired" the only observable, and a count cannot tell a loop
 * that stopped DELIBERATELY from one that fell over.
 *
 * The subject of each edit matters too. The revoke targets the second account; the grant targets
 * PUBLIC, which needs no second account at all. So the two edits cannot interfere, and the case
 * still reads as the bug report did: taking access away must not be hostage to giving it.
 */

// Read at runtime rather than imported: the repo is ESM, so a JSON import would need an attribute.
const here = dirname(fileURLToPath(import.meta.url))
const en = JSON.parse(
  readFileSync(resolve(here, '../../src/messages/en.json'), 'utf8')
) as { access: { publicLabel: string; saveFailedFor: string } }

const second = secondCredentials()

test.describe('11 - shares / a partly-failed save', () => {
  test.skip(
    !second,
    'set E2E_EMAIL_2 and E2E_PASSWORD_2 in .env.local — the revoke needs a grantee'
  )

  test('S13: a refused grant leaves the revoke beside it applied', async ({
    page,
    consoleGuard,
  }) => {
    // The injected 500 reaches the console as a network error, and a blanket ignore would hide a
    // real one. Narrow on purpose: a SECOND unexpected 500 from any other route still fails the
    // case.
    consoleGuard.expectError(/access\/grant.*500|500 \(Internal Server Error\)/)

    const objectName = `e2e-${Date.now()}-s13`
    await createObjectWithId(page, objectName)

    await page.goto('/objects')
    const row = page
      .getByTestId('data-table-row')
      .filter({ hasText: objectName })
      .first()
    await expect(row).toBeVisible()

    const openShare = async (): Promise<ReturnType<Page['getByRole']>> => {
      await row.getByTestId('object-actions-dropdown').click()
      await page.getByTestId('object-action-share').click()
      const panel = page.getByRole('dialog', { name: /share/i })
      await expect(panel).toBeVisible()
      return panel
    }

    // Seed the grant this case will revoke.
    let panel = await openShare()
    await page.getByTestId('share-add-people').click()
    await page.getByTestId('people-search').fill(second!.email)
    const option = page.getByRole('option').first()
    await expect(option).toBeVisible({ timeout: 15_000 })
    await option.click()
    const member = panel.locator('[data-testid^="share-member-"]').first()
    const subjectId = (await member.getAttribute('data-testid'))!.replace(
      'share-member-',
      ''
    )
    expect(subjectId, 'read the remove button, not the member row').not.toMatch(
      /^remove-/
    )
    await page.getByTestId('share-sheet-save').click()
    await expect(panel).toBeHidden()

    // ONLY the grant. The revoke is a different path and goes to the node untouched, so what lands
    // is the app's decision rather than the fixture's.
    await page.route('**/v1/access/grant', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ title: 'e2e injected failure' }),
      })
    )

    panel = await openShare()
    await expect(page.getByTestId(`share-member-${subjectId}`)).toBeVisible()

    // TWO edits, queued before the save: a revoke and a grant.
    await page.getByTestId(`share-member-remove-${subjectId}`).click()
    await page.getByTestId('share-public-toggle').click()

    // The INPUT side, asserted before the click. Without this, "the revoke landed" below is an
    // arithmetic accident — it would read the same if the public grant had never been queued at all,
    // which is the state a broken toggle produces.
    await expect(page.getByTestId(`share-member-${subjectId}`)).toHaveCount(0)
    await expect(page.getByTestId('share-public-toggle')).toBeChecked()

    await page.getByTestId('share-sheet-save').click()

    // The app's own ACCOUNT of the partial state, which is the discriminator: a loop that stopped
    // deliberately says WHICH edit failed; a loop that fell over says nothing.
    //
    // The WHOLE rendered message, built from the catalogue. `publicLabel` alone was vacuous, and
    // that was measured rather than assumed: "General access" is also the section `<Label>` sitting
    // in the sheet at all times, so with the refusal removed that version still passed with no toast
    // on screen. This string goes red there, which is what the case is for. A literal English
    // sentence would be a false red the moment the account is left in Dutch — the family this suite
    // keeps re-learning.
    const expected = en.access.saveFailedFor.replace(
      '{names}',
      en.access.publicLabel
    )
    await expect(page.getByText(expected)).toBeVisible()

    // The sheet STAYS OPEN on a partial failure — closing over a half-applied state is the thing
    // the fix explicitly refuses.
    await expect(panel).toBeVisible()

    // And the failed row snaps back to what the server still holds. Left alone it would keep
    // rendering what the user ASKED for, so a refusal would look exactly like a success.
    await expect(page.getByTestId('share-public-toggle')).not.toBeChecked()

    // Now the contract, read off STATE after a reload rather than off the request log: the revoke
    // landed and the grant did not. This is the assertion the bug report was about.
    await page.unroute('**/v1/access/grant')
    await page.reload()
    await expect(row).toBeVisible()
    await openShare()
    await expect(page.getByTestId(`share-member-${subjectId}`)).toHaveCount(0)
    await expect(page.getByTestId('share-public-toggle')).not.toBeChecked()
  })
})
