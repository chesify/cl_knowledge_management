from odoo import models, fields

class KnowledgeCategory(models.Model):
    _name = 'knowledge.category'
    _description = 'Knowledge Category'

    name = fields.Char(required=True)
    parent_id = fields.Many2one('knowledge.category', string='Parent Category')
    child_ids = fields.One2many('knowledge.category', 'parent_id', string='Subcategories')