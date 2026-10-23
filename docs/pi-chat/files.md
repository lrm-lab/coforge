# Working files

The sidebar shows this User/Workspace’s cloud Computer working directory,
shared by its workbench conversations. Files on the viewer’s own computer
are added through Upload.

- Expand directories, toggle hidden files, preview text/Markdown/code and raster
  images, download files, or insert a path into the unsent draft.
- Local links and file paths in answers open the viewer.
- Desktop width is adjustable and remembered; narrow screens use a dismissible drawer.
- Visible directory listings refresh every three seconds. Previews up to 1 MB
  refresh every five seconds; larger previews refresh explicitly.
- Uploads use bounded 192 KB chunks and unique names under `uploads/`, preserving
  existing files. Uploads and downloads have a 10 MB limit. Partial uploads are
  bounded to four per worker, expire after five minutes, and restart after a worker restart.
- The browser excludes native session/index storage, symbolic links, special
  files, and paths outside the private working directory.

File operations require `pi-chat-files:v1`. Computer capability status refreshes
every ten seconds, including after upgrades. Older Computers retain basic chat.

See [AI workbench](README.md) for execution, deployment and native conversation recovery,
and [Validation](validation.md) for the acceptance checklist.
