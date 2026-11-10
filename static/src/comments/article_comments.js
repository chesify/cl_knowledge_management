import { Component, computed, onWillStart, markup, proxy, t, useProps } from "@odoo/owl";
import { deserializeDateTime } from "@web/core/l10n/dates";
import { rpc } from "@web/core/network/rpc";
import { user } from "@web/core/user";
import { useService } from "@web/core/utils/hooks";

const MAX_INDENT = 4;

export class ArticleComments extends Component {
    static template = "cl_knowledge_management.ArticleComments";

    props = useProps({ articleId: t.number() });

    currentAvatar = `/web/image/res.partner/${user.partnerId}/avatar_128`;

    setup() {
        this.orm = useService("orm");
        this.state = proxy({
            messages: [],
            draft: "",
            replyTo: null,
            replyDraft: "",
            posting: false,
        });
        this.rows = computed(() => this.computeRows());
        onWillStart(() => this.load());
    }

    async load() {
        this.state.messages = await rpc(`/knowledge/article/${this.props.articleId}/messages`, {});
    }

    /** Depth-first flat list, so the template needs no recursion. */
    computeRows() {
        const known = new Set(this.state.messages.map((m) => m.id));
        const children = new Map();
        for (const message of this.state.messages) {
            const key = known.has(message.parent_id) ? message.parent_id : 0;
            children.set(key, [...(children.get(key) || []), message]);
        }
        const rows = [];
        const walk = (key, depth) => {
            for (const message of children.get(key) || []) {
                rows.push({
                    message,
                    depth: Math.min(depth, MAX_INDENT),
                    body: markup(message.body || ""),
                    date: deserializeDateTime(message.date).toRelative(),
                    avatar: message.author_id
                        ? `/web/image/res.partner/${message.author_id}/avatar_128`
                        : "",
                });
                walk(message.id, depth + 1);
            }
        };
        walk(0, 0);
        return rows;
    }

    startReply(message) {
        this.state.replyTo = this.state.replyTo === message.id ? null : message.id;
        this.state.replyDraft = "";
    }

    async post(body, parentId = false) {
        const text = body.trim();
        if (!text || this.state.posting) {
            return false;
        }
        this.state.posting = true;
        try {
            await this.orm.call("knowledge.article", "message_post", [this.props.articleId], {
                body: text,
                message_type: "comment",
                subtype_xmlid: "mail.mt_comment",
                context: { mail_post_autofollow_author_skip: true },
                ...(parentId ? { parent_id: parentId } : {}),
            });
            await this.load();
            return true;
        } finally {
            this.state.posting = false;
        }
    }

    async postComment() {
        if (await this.post(this.state.draft)) {
            this.state.draft = "";
        }
    }

    async postReply() {
        if (await this.post(this.state.replyDraft, this.state.replyTo)) {
            this.state.replyTo = null;
            this.state.replyDraft = "";
        }
    }

    onComposerKeydown(ev, submit) {
        if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
            ev.preventDefault();
            submit();
        }
    }
}
