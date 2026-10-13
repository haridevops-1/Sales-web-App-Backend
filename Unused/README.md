# Unused

Retired code kept for reference. Nothing here is deployed: `catalyst.json` only targets `functions/`.

| Folder | What it was | Replaced by |
|---|---|---|
| `spikra_document_process` | Workspace 1 text extraction (Basic I/O) | `functions/spikra_document_process_v2` |
| `spikra_experience_generate` | Workspace 1 showcase renderer (Basic I/O) | `functions/spikra_experience_generate_v2` |
| `spikra_process_status` | Workspace 1 status polling (Basic I/O) | `functions/spikra_process_status_v2` |
| `spikra_experience_list` | Workspace 1 showcase list (Basic I/O) | `functions/spikra_experience_list_v2` |

These are the originals from before sign-in was added. Basic I/O functions cannot check the signed-in user's token, so the `_v2` versions run as Advanced I/O behind the auth adapter. The business logic is unchanged.

Once the `_v2` functions are verified, delete the four matching functions in the Catalyst Console (Serverless → Functions); then this folder can be removed.
