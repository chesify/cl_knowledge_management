from odoo import fields, http
from odoo.http import request


class KnowledgeController(http.Controller):

    @http.route('/knowledge/article/<int:article_id>/messages', type='jsonrpc', auth='user')
    def get_article_messages(self, article_id):
        article = request.env['knowledge.article'].browse(article_id).exists()
        if not article:
            return []
        article.check_access('read')

        messages = article.message_ids.filtered(lambda m: m.message_type == 'comment').sorted('date')
        return [{
            'id': msg.id,
            'parent_id': msg.parent_id.id if msg.parent_id in messages else None,
            'author': msg.author_id.name or msg.email_from or '',
            'author_id': msg.author_id.id,
            'body': msg.body,
            'date': fields.Datetime.to_string(msg.date),
        } for msg in messages]

    @http.route('/knowledge/article/<string:token>', type='http', auth='public')
    def article_public_view(self, token, **kwargs):
        article = request.env['knowledge.article'].sudo().search([
            ('share_token', '=', token),
            ('is_published', '=', True),
        ], limit=1)
        if not article:
            return request.not_found()
        return request.render('cl_knowledge_management.article_public_template', {'article': article})

    @http.route('/knowledge/article/increment_view', type='jsonrpc', auth='user')
    def increment_view(self, article_id):
        article = request.env['knowledge.article'].browse(article_id).exists()
        if article:
            article.check_access('read')
            article.sudo()._increment_views()
            request.env['knowledge.article.view.log'].sudo().create({
                'article_id': article.id,
                'user_id': request.env.uid,
            })
