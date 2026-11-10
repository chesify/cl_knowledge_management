from odoo import models, fields

class KnowledgeTag(models.Model):
    _name = 'knowledge.tag'
    _description = 'Knowledge Tag'

    name = fields.Char(string='Name', required=True)
    color = fields.Integer(string='Color Index')
    description = fields.Char(string='Description')