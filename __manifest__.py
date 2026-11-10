{
    "name": "Knowledge Management",
    "summary": "A fast, organized, collaborative knowledge hub inside Odoo Community Edition",
    "description": """
        A fast, organized, collaborative knowledge hub inside Odoo Community Edition.
    """,
    "version": "20.0.1.0.0",
    "author": "Chesify Labs",
    "company": "Chesify Labs",
    "maintainer": "Chesify Labs",
    "website": "http://chesifylabs.co.tz",
    "license": "LGPL-3",
    "category": "Knowledge",
    "depends": ["base", "mail", "web", "hr", "html_editor"],
    "data": [
        "security/ir.access.csv",
        "views/knowledge_views.xml",
        "views/knowledge_menus.xml",
        "views/article_public_template.xml",
    ],
    "assets": {
        "web.assets_backend": [
            "cl_knowledge_management/static/src/workspace/**/*",
            "cl_knowledge_management/static/src/dialogs/**/*",
            "cl_knowledge_management/static/src/comments/**/*",
        ],
        "web.assets_frontend": [
            "cl_knowledge_management/static/src/public/**/*",
        ],
    },
    "images": ["static/description/banner.png"],
    "installable": True,
    "application": True,
    "price": 0.00,
    "currency": "USD",
}
