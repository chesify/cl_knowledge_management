from odoo import models, fields

class KnowledgeArticleViewLog(models.Model):
    _name = 'knowledge.article.view.log'
    _description = 'Knowledge View Log'

    article_id = fields.Many2one("knowledge.article", required=True, ondelete="cascade")
    user_id = fields.Many2one("res.users", default=lambda self: self.env.user)
    viewed_on = fields.Datetime(default=fields.Datetime.now)
