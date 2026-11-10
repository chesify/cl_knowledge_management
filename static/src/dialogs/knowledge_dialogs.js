import { Component, computed, markup, onWillStart, proxy, signal, t, useProps } from "@odoo/owl";
import { CheckBox } from "@web/core/checkbox/checkbox";
import { Dialog } from "@web/core/dialog/dialog";
import { deserializeDateTime } from "@web/core/l10n/dates";
import { _t } from "@web/core/l10n/translation";
import { useAutofocus, useService } from "@web/core/utils/hooks";
import { useDebounced } from "@web/core/utils/timing";

const SEARCH_DELAY = 200;
const CONTENT_SEARCH_STORAGE_KEY = "cl_knowledge.search_in_content";

export class KnowledgePromptDialog extends Component {
    static template = "cl_knowledge_management.PromptDialog";
    static components = { Dialog };

    props = useProps({
        close: t.function(),
        title: t.string(),
        label: t.string(),
        value: t.string().optional(""),
        placeholder: t.string().optional(""),
        hint: t.string().optional(""),
        confirmLabel: t.string(),
        readonly: t.boolean().optional(false),
        onConfirm: t.function(),
    });

    inputRef = signal.ref();

    setup() {
        this.state = proxy({ value: this.props.value, busy: false });
        useAutofocus({ ref: this.inputRef, selectAll: true });
    }

    canConfirm() {
        return !this.state.busy && !!this.state.value.trim();
    }

    async confirm() {
        if (!this.canConfirm()) {
            return;
        }
        this.state.busy = true;
        try {
            await this.props.onConfirm(this.state.value.trim());
            this.props.close();
        } finally {
            this.state.busy = false;
        }
    }
}

export class KnowledgeSearchDialog extends Component {
    static template = "cl_knowledge_management.SearchDialog";
    static components = { CheckBox, Dialog };

    props = useProps({
        close: t.function(),
        articleIds: t.array(t.number()),
        filtered: t.boolean(),
        onOpen: t.function(),
    });

    inputRef = signal.ref();

    setup() {
        this.orm = useService("orm");
        this.state = proxy({
            query: "",
            inContent: localStorage.getItem(CONTENT_SEARCH_STORAGE_KEY) === "1",
            results: [],
            active: 0,
            searched: false,
        });
        this.requestId = 0;
        this.debouncedSearch = useDebounced(() => this.search(), SEARCH_DELAY);
        useAutofocus({ ref: this.inputRef });
    }

    onInput() {
        this.debouncedSearch();
    }

    toggleContent() {
        this.state.inContent = !this.state.inContent;
        localStorage.setItem(CONTENT_SEARCH_STORAGE_KEY, this.state.inContent ? "1" : "0");
        this.inputRef()?.focus();
        this.search();
    }

    async search() {
        const requestId = ++this.requestId;
        const query = this.state.query.trim();
        if (!query) {
            this.state.results = [];
            this.state.searched = false;
            return;
        }
        const results = await this.orm.call("knowledge.article", "search_workspace", [query], {
            in_content: this.state.inContent,
            article_ids: this.props.articleIds,
        });
        if (requestId === this.requestId) {
            this.state.results = results;
            this.state.active = 0;
            this.state.searched = true;
        }
    }

    /** Split around the first match, so the match is emphasised without building HTML. */
    highlight(text) {
        const query = this.state.query.trim().toLowerCase();
        const index = text.toLowerCase().indexOf(query);
        if (!query || index === -1) {
            return { before: text, match: "", after: "" };
        }
        return {
            before: text.slice(0, index),
            match: text.slice(index, index + query.length),
            after: text.slice(index + query.length),
        };
    }

    onKeydown(ev) {
        const count = this.state.results.length;
        if (ev.key === "ArrowDown" && count) {
            ev.preventDefault();
            this.state.active = (this.state.active + 1) % count;
        } else if (ev.key === "ArrowUp" && count) {
            ev.preventDefault();
            this.state.active = (this.state.active - 1 + count) % count;
        } else if (ev.key === "Enter" && count) {
            ev.preventDefault();
            this.open(this.state.results[this.state.active]);
        }
    }

    open(result) {
        this.props.onOpen(result.id);
        this.props.close();
    }
}

export class KnowledgeMoveDialog extends Component {
    static template = "cl_knowledge_management.MoveDialog";
    static components = { Dialog };

    props = useProps({
        close: t.function(),
        article: t.object(),
        articles: t.array(t.object()),
        invalidIds: t.instanceOf(Set),
        onConfirm: t.function(),
    });

    setup() {
        this.state = proxy({ target: this.props.article.parent_id || null, busy: false });
        this.rows = computed(() => this.computeRows());
    }

    computeRows() {
        const ids = new Set(this.props.articles.map((a) => a.id));
        const children = new Map();
        for (const article of this.props.articles) {
            const key = ids.has(article.parent_id) ? article.parent_id : 0;
            children.set(key, [...(children.get(key) || []), article]);
        }
        const rows = [];
        const walk = (key, depth) => {
            for (const article of (children.get(key) || []).sort((a, b) => a.name.localeCompare(b.name))) {
                rows.push({ article, depth, disabled: this.props.invalidIds.has(article.id) });
                walk(article.id, depth + 1);
            }
        };
        walk(0, 0);
        return rows;
    }

    async confirm() {
        this.state.busy = true;
        try {
            await this.props.onConfirm(this.state.target);
            this.props.close();
        } finally {
            this.state.busy = false;
        }
    }
}

export class KnowledgeTagsDialog extends Component {
    static template = "cl_knowledge_management.TagsDialog";
    static components = { Dialog };

    props = useProps({
        close: t.function(),
        tags: t.array(t.object()),
        selected: t.array(t.number()),
        onConfirm: t.function(),
    });

    setup() {
        this.state = proxy({ search: "", selected: [...this.props.selected], busy: false });
    }

    visibleTags() {
        const query = this.state.search.trim().toLowerCase();
        return this.props.tags.filter((tag) => tag.name.toLowerCase().includes(query));
    }

    toggle(tag) {
        const selected = this.state.selected;
        this.state.selected = selected.includes(tag.id)
            ? selected.filter((id) => id !== tag.id)
            : [...selected, tag.id];
    }

    async confirm() {
        this.state.busy = true;
        try {
            await this.props.onConfirm([...this.state.selected]);
            this.props.close();
        } finally {
            this.state.busy = false;
        }
    }
}

export class KnowledgeVersionsDialog extends Component {
    static template = "cl_knowledge_management.VersionsDialog";
    static components = { Dialog };

    CURRENT = "current";

    props = useProps({
        close: t.function(),
        article: t.object(),
        currentVersion: t.number(),
    });

    setup() {
        this.orm = useService("orm");
        this.state = proxy({
            versions: [],
            selected: null,
            compareWith: this.CURRENT,
            diff: null,
            loading: false,
        });
        onWillStart(() => this.load());
    }

    async load() {
        const versions = await this.orm.searchRead(
            "knowledge.article.version",
            [["article_id", "=", this.props.article.id]],
            ["id", "version_number", "create_date", "user_id"],
            { order: "version_number desc" }
        );
        this.state.versions = versions.map((version) => ({
            ...version,
            relative: deserializeDateTime(version.create_date).toRelative(),
        }));
        if (versions.length) {
            await this.select(this.state.versions[0]);
        }
    }

    async select(version) {
        this.state.selected = version;
        if (this.state.compareWith === version.id) {
            this.state.compareWith = this.CURRENT;
        }
        await this.refreshDiff();
    }

    async setCompareWith(ev) {
        const value = ev.target.value;
        this.state.compareWith = value === this.CURRENT ? value : Number(value);
        await this.refreshDiff();
    }

    /** Swapping needs two saved versions: the live article has no version record. */
    canSwap() {
        return this.state.compareWith !== this.CURRENT;
    }

    async swap() {
        const other = this.state.versions.find((v) => v.id === this.state.compareWith);
        const previous = this.state.selected;
        this.state.selected = other;
        this.state.compareWith = previous.id;
        await this.refreshDiff();
    }

    async refreshDiff() {
        const { selected, compareWith } = this.state;
        this.state.loading = true;
        const diff = await this.orm.call(
            "knowledge.article",
            "get_version_diff",
            [[this.props.article.id], selected.id, compareWith === this.CURRENT ? false : compareWith]
        );
        // The server builds this from difflib output, which escapes the article text.
        this.state.diff = markup(diff);
        this.state.loading = false;
    }

    title() {
        return _t("Version history: %(name)s", { name: this.props.article.name });
    }
}
