## Installation

1. Copy the `cl_knowledge_management` folder into one of your Odoo addons
   paths, for example `custom_module`.
2. Restart the Odoo service.
3. Go to **Apps**, update the apps list, search for *Knowledge Management* and
   click **Install**.

The module needs the **Employees** (`hr`) app, which is installed
automatically. Odoo uses it for department-based access.

## Access rights

Every article has two sets of rights. Set them through
**⋯ → Access rights & settings**, which opens the **Access Rights** tab of the
article form:

| Right | Options |
|---|---|
| **View** | Everyone, specific users, or specific departments |
| **Edit** | Everyone, specific users, or specific departments |

- The **author** and the **creator** of an article can always see it.
- **Settings administrators** can see and manage every article.
- A new child article copies its parent's rights when it is created.
  Changing a parent's rights later does **not** update its existing children.
- Department access uses the department on the user's **Employee** record, so
  link each user to an employee.

## Tags and categories

- **Tags**: *Knowledge → Configuration → Tags*. Pick a colour for each tag.
  The colour is used in the workspace.
- **Categories**: optional, set on the article form.

## Public sharing

Each article has a share token. Only **published** articles can be opened
through their public link. Unpublish an article to stop sharing it.
