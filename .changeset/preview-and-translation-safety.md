---
"@atmyapp/core": minor
"@atmyapp/structure": minor
---

Collection reads keep the server's `previewApproximate` flag: `dataWithMeta` results carry it, `onPreviewApproximate` is called (a console warning by default), and `strictPreview` turns an approximate preview into a failed request that follows `errorPolicy`. The structure package adds `pruneDeletedItemTranslations`, which drops translations of source items that were deleted, and `validateLocalizedOverlayFields`, which reports translated values for fields that are not localized (`not-localizable`).
