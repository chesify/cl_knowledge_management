import uuid

import lxml.html
from lxml import etree

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.fields import Command, Domain
from odoo.tools import SQL, html2plaintext

from .knowledge_article_version import generate_version_diff

WORKSPACE_FIELDS = [
    "id", "name", "parent_id", "tag_ids", "active", "display_name",
    "views_count", "likes_count", "liked_by_ids", "create_date", "write_date",
    "create_uid", "write_uid", "share_token",
]
SEARCH_SCAN_LIMIT = 200
SNIPPET_RADIUS = 60


class KnowledgeArticle(models.Model):
    _name = 'knowledge.article'
    _description = 'Knowledge Article'
    _inherit = ['mail.thread', 'mail.activity.mixin']
    _order = 'create_date desc'
    _mail_flat_thread = False  # comments are threaded: replies keep their real parent

    _active_is_published_idx = models.Index("(active, is_published)")
    _write_date_idx = models.Index("(write_date)")
    _create_date_idx = models.Index("(create_date)")

    name = fields.Char(required=True, tracking=True)
    content = fields.Html('Content')
    category_id = fields.Many2one('knowledge.category', string='Category', tracking=True)
    tag_ids = fields.Many2many('knowledge.tag', string='Tags')
    attachment_ids = fields.Many2many('ir.attachment', string='Attachments')
    version = fields.Integer(default=1)
    is_published = fields.Boolean(default=True, tracking=True)
    author_id = fields.Many2one('res.users', string='Author', default=lambda self: self.env.user)
    editor_ids = fields.Many2many('res.users', 'knowledge_article_editor_rel', 'article_id', 'user_id')
    viewer_ids = fields.Many2many('res.users', 'knowledge_article_viewer_rel', 'article_id', 'user_id')
    is_locked = fields.Boolean(default=False)
    parent_id = fields.Many2one('knowledge.article', string="Parent Article", ondelete="restrict", index=True)
    child_ids = fields.One2many('knowledge.article', 'parent_id', string="Child Articles")
    active = fields.Boolean(default=True)

    # Access rights
    view_everyone = fields.Boolean(
        string="View: Everyone", default=True,
        help="Applies to this article and cascades to children unless overridden.",
    )
    view_user_ids = fields.Many2many(
        'res.users',
        'knowledge_article_view_users_rel',
        'article_id', 'user_id',
        string='View: Specific Users',
        domain="[('employee_id', '!=', False), ('employee_id.active', '=', True)]",
        help="Inherited from parent if not changed.",
    )
    view_department_ids = fields.Many2many(
        'hr.department',
        'knowledge_article_view_dept_rel',
        'article_id', 'department_id',
        string='View: Specific Departments',
        help="Inherited from parent if not changed.",
    )
    edit_everyone = fields.Boolean(
        string="Edit: Everyone", default=True,
        help="Applies to this article and cascades to children unless overridden.",
    )
    edit_user_ids = fields.Many2many(
        'res.users',
        'knowledge_article_edit_users_rel',
        'article_id', 'user_id',
        string='Edit: Specific Users',
        domain="[('employee_id', '!=', False), ('employee_id.active', '=', True)]",
        help="Inherited from parent if not changed.",
    )
    edit_department_ids = fields.Many2many(
        'hr.department',
        'knowledge_article_edit_dept_rel',
        'article_id', 'department_id',
        string='Edit: Specific Departments',
        help="Inherited from parent if not changed.",
    )

    access_inherited = fields.Boolean(string="Access Inherited", compute='_compute_access_inherited')
    version_ids = fields.One2many('knowledge.article.version', 'article_id', string="Versions")

    share_token = fields.Char(string="Share Token", readonly=True, index=True, copy=False)
    views_count = fields.Integer(string="Views", readonly=True, copy=False)
    liked_by_ids = fields.Many2many(
        "res.users", string="Liked By", relation="knowledge_article_likes_rel", readonly=True, copy=False,
    )
    likes_count = fields.Integer(string="Likes", compute="_compute_likes_count", store=True)

    @api.constrains('parent_id')
    def _check_parent_id(self):
        if self._has_cycle():
            raise ValidationError(_("An article cannot be moved inside itself or one of its children."))

    @api.depends('liked_by_ids')
    def _compute_likes_count(self):
        for rec in self:
            rec.likes_count = len(rec.liked_by_ids)

    @api.depends('name', 'parent_id')
    def _compute_display_name(self):
        for article in self:
            names = []
            current = article.sudo()
            while current:
                names.append(current.name or '')
                current = current.parent_id
            article.display_name = " / ".join(reversed(names))

    @api.depends(
        'parent_id', 'view_everyone', 'view_user_ids', 'view_department_ids',
        'edit_everyone', 'edit_user_ids', 'edit_department_ids',
    )
    def _compute_access_inherited(self):
        for rec in self:
            parent = rec.parent_id
            rec.access_inherited = bool(parent) and (
                rec.view_everyone == parent.view_everyone
                and rec.view_user_ids == parent.view_user_ids
                and rec.view_department_ids == parent.view_department_ids
                and rec.edit_everyone == parent.edit_everyone
                and rec.edit_user_ids == parent.edit_user_ids
                and rec.edit_department_ids == parent.edit_department_ids
            )

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            vals['version'] = 1
            if 'author_id' not in vals:
                vals['author_id'] = self.env.uid
            if vals.get('content'):
                vals['content'] = self._clean_article_content(vals['content'])
            if not vals.get('share_token'):
                vals['share_token'] = uuid.uuid4().hex

        # Favorites are follows: writing an article must not favorite it.
        articles = super(KnowledgeArticle, self.with_context(mail_create_nosubscribe=True)).create(vals_list)

        for article in articles.filtered('parent_id'):
            article.sudo().write(article.parent_id._get_access_values())
        return articles

    def write(self, vals):
        restricted_keys = {'name', 'content', 'tag_ids', 'parent_id', 'active', 'is_published', 'share_token'}
        if not restricted_keys.isdisjoint(vals):
            for rec in self:
                if not rec.can_edit():
                    raise UserError(_("You don't have edit access to this article."))

            if 'content' in vals:
                vals['content'] = self._clean_article_content(vals['content'])
                for rec in self:
                    self.env['knowledge.article.version'].create({
                        'article_id': rec.id,
                        'content': rec.content,
                        'version_number': rec.version,
                        'user_id': self.env.uid,
                    })
                    rec.version += 1

        return super().write(vals)

    def unlink(self):
        if not self.env.user.has_group('base.group_system'):
            if any(self.mapped('is_published')):
                raise UserError(_("Published articles cannot be deleted. Please archive them instead."))
            raise AccessError(_("Only admins can delete articles."))
        return super().unlink()

    def _get_access_values(self):
        self.ensure_one()
        return {
            'view_everyone': self.view_everyone,
            'view_user_ids': [Command.set(self.view_user_ids.ids)],
            'view_department_ids': [Command.set(self.view_department_ids.ids)],
            'edit_everyone': self.edit_everyone,
            'edit_user_ids': [Command.set(self.edit_user_ids.ids)],
            'edit_department_ids': [Command.set(self.edit_department_ids.ids)],
        }

    def _cascade_archive(self):
        self.child_ids.filtered('active').write({'active': False})

    def _cascade_access_rights(self):
        for article in self:
            children = article.child_ids
            children.write(article._get_access_values())
            children._cascade_access_rights()

    def can_view(self):
        self.ensure_one()
        user = self.env.user
        if user.has_group("base.group_system"):
            return True
        if self.view_everyone or user in self.view_user_ids or self.author_id == user:
            return True
        return bool(user.employee_id and user.employee_id.department_id in self.view_department_ids)

    def can_edit(self):
        self.ensure_one()
        user = self.env.user
        if user.has_group("base.group_system"):
            return True
        if self.edit_everyone or self.author_id == user or user in self.edit_user_ids:
            return True
        return bool(user.employee_id and user.employee_id.department_id in self.edit_department_ids)

    def action_view_versions(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Version History'),
            'res_model': 'knowledge.article.version',
            'view_mode': 'list,form',
            'domain': [('article_id', '=', self.id)],
            'context': {'default_article_id': self.id, 'create': False},
            'target': 'current',
        }

    def _clean_article_content(self, html):
        """Drop images pointing at the author's local disk: nobody else can load them."""
        if not html or 'file://' not in html:
            return html
        root = lxml.html.fromstring(f"<div>{html}</div>")
        for img in root.xpath("//img[starts-with(@src, 'file://')]"):
            img.drop_tree()
        return etree.tostring(root, encoding='unicode', method='html')[len('<div>'):-len('</div>')]

    # ------------------------------------------------------------
    # Workspace API
    # ------------------------------------------------------------

    @api.model
    def get_workspace_data(self):
        """Everything the workspace needs to draw its sidebar, in one call."""
        articles = self.with_context(active_test=False).search_read(
            [('is_published', '=', True)], WORKSPACE_FIELDS,
        )
        followed = self.env['mail.followers'].sudo().search([
            ('res_model', '=', self._name),
            ('partner_id', '=', self.env.user.partner_id.id),
        ])
        return {
            'articles': articles,
            'tags': self.env['knowledge.tag'].search_read([], ['id', 'name', 'color'], order='name'),
            'favorite_ids': followed.mapped('res_id'),
        }

    def get_article_details(self):
        self.ensure_one()
        self.check_access('read')
        return {
            'content': self.content or '',
            'version': self.version,
            'can_edit': self.can_edit(),
            'can_archive': self.create_uid == self.env.user or self.env.user.has_group('base.group_system'),
        }

    @api.model
    def search_workspace(self, query, in_content=False, article_ids=None, limit=30):
        """Search titles, and optionally the visible text of articles.

        Matching on ``content`` alone would also hit HTML tags and attributes,
        so content candidates are confirmed against their plain text.
        """
        query = (query or '').strip()
        if not query:
            return []
        domain = Domain('name', 'ilike', query)
        if in_content:
            domain |= Domain('content', 'ilike', query)
        if article_ids is not None:
            domain &= Domain('id', 'in', article_ids)

        needle = query.casefold()
        results = []
        articles = self.with_context(active_test=False).search_fetch(
            domain, ['name', 'content', 'display_name'], limit=SEARCH_SCAN_LIMIT,
        )
        for article in articles:
            snippet = ''
            if in_content and article.content:
                text = " ".join(html2plaintext(article.content).split())
                position = text.casefold().find(needle)
                if position != -1:
                    start = max(position - SNIPPET_RADIUS, 0)
                    end = position + len(query) + SNIPPET_RADIUS
                    snippet = text[start:end]
            if snippet or needle in article.name.casefold():
                results.append({
                    'id': article.id,
                    'name': article.name,
                    'display_name': article.display_name,
                    'snippet': snippet,
                })
            if len(results) >= limit:
                break
        return results

    def get_version_diff(self, old_version_id, new_version_id=False):
        """Compare a saved version with another one, or with the live article."""
        self.ensure_one()
        self.check_access('read')
        Version = self.env['knowledge.article.version']
        old = Version.browse(old_version_id)
        if old.article_id != self:
            raise UserError(_("This version does not belong to the article."))
        if new_version_id:
            new = Version.browse(new_version_id)
            if new.article_id != self:
                raise UserError(_("This version does not belong to the article."))
            new_content, new_number = new.content, new.version_number
        else:
            new_content, new_number = self.content, self.version
        return generate_version_diff(old.content, new_content, old.version_number, new_number)

    def _increment_views(self):
        """Count a view without touching write_date: reading is not editing."""
        self.env.cr.execute(SQL(
            "UPDATE knowledge_article SET views_count = COALESCE(views_count, 0) + 1 WHERE id IN %s",
            tuple(self.ids),
        ))
        self.invalidate_recordset(['views_count'])

    def _set_liked(self, liked):
        """Add or remove the user's like in SQL: an ORM write would change write_date and write_uid."""
        self.ensure_one()
        field = self._fields['liked_by_ids']
        relation = SQL.identifier(field.relation)
        article_column, user_column = SQL.identifier(field.column1), SQL.identifier(field.column2)
        self.env.cr.execute(
            SQL(
                "INSERT INTO %s (%s, %s) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                relation, article_column, user_column, self.id, self.env.uid,
            ) if liked else SQL(
                "DELETE FROM %s WHERE %s = %s AND %s = %s",
                relation, article_column, self.id, user_column, self.env.uid,
            )
        )
        self.env.cr.execute(SQL(
            "UPDATE knowledge_article SET likes_count = (SELECT COUNT(*) FROM %s WHERE %s = %s) WHERE id = %s",
            relation, article_column, self.id, self.id,
        ))
        self.invalidate_recordset(['liked_by_ids', 'likes_count'])

    @api.model
    def action_toggle_like(self, article_id):
        rec = self.browse(article_id).exists()
        rec.check_access('read')

        uid = self.env.uid
        you_liked = uid not in rec.sudo().liked_by_ids.ids
        rec._set_liked(you_liked)
        liked_ids = rec.sudo().liked_by_ids.ids
        return {
            'you_liked': you_liked,
            'liked_by_ids': liked_ids,
            'likes_count': len(liked_ids),
        }

    @api.model
    def action_toggle_follow(self, article_id):
        rec = self.browse(article_id).exists()
        rec.check_access('read')

        partner = self.env.user.partner_id
        is_following = bool(self.env['mail.followers'].sudo().search_count([
            ('res_model', '=', self._name),
            ('res_id', '=', rec.id),
            ('partner_id', '=', partner.id),
        ]))
        if is_following:
            rec.sudo().message_unsubscribe(partner_ids=partner.ids)
        else:
            rec.sudo().message_subscribe(partner_ids=partner.ids)
        return {'following': not is_following}
