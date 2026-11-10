**Knowledge Management** gives your company one place to write, organise and
find everything your team knows. It is a modern, Notion-style knowledge base
built directly into Odoo 20, so it works in Community and does not need an
external wiki.

Articles live in a tree. A handbook can hold policies, the policies can hold
procedures, and everyone sees only the parts they are allowed to see.

## Key features

- **Workspace view**: a three-pane layout with a resizable, collapsible
  sidebar. It shows your favourites and the full article tree, with sorting
  and filters.
- **Nested articles**: you can nest pages to any depth and move them anywhere
  in the tree. The module blocks moves that would put an article inside itself.
- **Inline editing**: articles open in Odoo's own rich-text editor, right on
  the page. Type `/` to insert headings, lists, tables, quotes and more.
- **Instant search**: a keyboard-driven search palette that matches titles
  and, optionally, article content, with highlighted matches.
- **Reading comfort**: articles have breadcrumbs, an automatic "On this page"
  outline, a reading-time estimate and coloured tags.
- **Version history**: a new version is saved every time content changes. You
  can compare any two versions side by side, or compare a version with the
  live article.
- **Threaded comments**: discuss an article underneath it, with replies.
- **Favourites and likes**: star articles to pin them in the sidebar, and see
  what colleagues find useful.
- **Access control**: set who can view and who can edit each article. You can
  allow everyone, specific users, or whole departments. The author and the
  creator always keep access.
- **Public sharing**: published articles can be shared through a private link
  that works without an Odoo login.
- **Chatter**: every article has the standard Odoo chatter, with tracking of
  title, category and publication changes.
- **Mobile ready**: the workspace adapts to phones and tablets.

## Technical overview

| Model | Purpose |
|---|---|
| `knowledge.article` | The article itself: content, tree position, access rights, likes, views, share token |
| `knowledge.article.version` | Snapshot of the content each time it changes |
| `knowledge.version.compare.wizard` | Side-by-side diff between versions |
| `knowledge.article.view.log` | Record of who viewed what, visible to administrators |
| `knowledge.tag` | Coloured tags |
| `knowledge.category` | Optional categories |

Built for Odoo 20 with OWL 3, the `html_editor` editor and the new
`ir.access` security model. It depends on `base`, `mail`, `web`, `hr` and
`html_editor`.
