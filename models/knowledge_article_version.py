import difflib

from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import html2plaintext


def generate_version_diff(old, new, old_number=None, new_number=None):
    """Side-by-side text diff of two HTML contents, as an HTML table."""
    diff_table = difflib.HtmlDiff(tabsize=4, wrapcolumn=80).make_table(
        html2plaintext(old or '').splitlines(),
        html2plaintext(new or '').splitlines(),
        fromdesc=f'Version {old_number or "?"}',
        todesc=f'Version {new_number or "?"}',
        context=True,
        numlines=2,
    )
    return f'<div class="o_diff_content">{diff_table}</div>'


class KnowledgeArticleVersion(models.Model):
    _name = 'knowledge.article.version'
    _description = 'Knowledge Article Version'
    _order = 'create_date desc'

    article_id = fields.Many2one('knowledge.article', string='Article', required=True, ondelete="cascade", index=True)
    version_number = fields.Integer(string="Version", required=True)
    content = fields.Html(string="Content Snapshot")
    user_id = fields.Many2one('res.users', string="Saved By", default=lambda self: self.env.user, readonly=True)

    @api.depends('article_id.name', 'version_number')
    def _compute_display_name(self):
        for rec in self:
            rec.display_name = f"{rec.article_id.name} v{rec.version_number}"

    def action_compare_with_current(self):
        self.ensure_one()
        latest = self.search([('article_id', '=', self.article_id.id)], order='version_number desc', limit=1)
        return self._action_open_compare(self, latest)

    @api.model
    def action_compare_selected_versions(self, records):
        if len(records) != 2:
            raise UserError(_("Please select exactly 2 versions to compare."))
        old, new = records.sorted('version_number')
        return self._action_open_compare(old, new)

    @api.model
    def _action_open_compare(self, old, new):
        return {
            'type': 'ir.actions.act_window',
            'name': _('Compare Versions'),
            'res_model': 'knowledge.version.compare.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'default_article_id': old.article_id.id,
                'default_old_version_id': old.id,
                'default_current_version_id': new.id,
            },
        }


class KnowledgeVersionCompareWizard(models.TransientModel):
    _name = 'knowledge.version.compare.wizard'
    _description = 'Compare Article Versions'

    article_id = fields.Many2one('knowledge.article', string='Current Article', required=True)
    old_version_id = fields.Many2one('knowledge.article.version', string='Old Version', required=True)
    current_version_id = fields.Many2one('knowledge.article.version', string="Current Version", required=True)
    current_content = fields.Html(string="Current Content", readonly=True)
    old_content = fields.Html(string="Previous Content", readonly=True)
    diff_html = fields.Html(string="Difference")

    @api.model_create_multi
    def create(self, vals_list):
        Version = self.env['knowledge.article.version']
        for vals in vals_list:
            old = Version.browse(vals.get('old_version_id'))
            current = Version.browse(vals.get('current_version_id'))
            vals.update({
                'old_content': old.content or '',
                'current_content': current.content or '',
                'diff_html': generate_version_diff(
                    old.content, current.content, old.version_number, current.version_number,
                ),
            })
        return super().create(vals_list)
