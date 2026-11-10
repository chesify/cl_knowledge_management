import {
    MAIN_PLUGINS,
    NO_EMBEDDED_COMPONENTS_FALLBACK_PLUGINS,
} from "@html_editor/plugin_sets";
import { Wysiwyg } from "@html_editor/wysiwyg";
import { Component, computed, markup, onWillStart, proxy, signal, useListener, useProps } from "@odoo/owl";
import { browser } from "@web/core/browser/browser";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { Dropdown } from "@web/core/dropdown/dropdown";
import { DropdownItem } from "@web/core/dropdown/dropdown_item";
import { CheckBox } from "@web/core/checkbox/checkbox";
import { deserializeDateTime } from "@web/core/l10n/dates";
import { localization } from "@web/core/l10n/localization";
import { _t } from "@web/core/l10n/translation";
import { rpc } from "@web/core/network/rpc";
import { registry } from "@web/core/registry";
import { router } from "@web/core/browser/router";
import { user } from "@web/core/user";
import { useService } from "@web/core/utils/hooks";
import { useSetupAction } from "@web/search/action_hook";
import { standardActionServiceProps } from "@web/webclient/actions/action_plugin";
import { ArticleComments } from "../comments/article_comments";
import {
    KnowledgeMoveDialog,
    KnowledgePromptDialog,
    KnowledgeSearchDialog,
    KnowledgeTagsDialog,
    KnowledgeVersionsDialog,
} from "../dialogs/knowledge_dialogs";

const STORAGE_PREFIX = "cl_knowledge.";
const SIDEBAR_DEFAULT_WIDTH = 300;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 560;
const WORDS_PER_MINUTE = 200;
const VIEW_DELAY = 1000;

function readStorage(key, fallback) {
    try {
        const value = browser.localStorage.getItem(STORAGE_PREFIX + key);
        return value === null ? fallback : JSON.parse(value);
    } catch {
        return fallback;
    }
}

function writeStorage(key, value) {
    try {
        browser.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    } catch {
        // Storage can be full or blocked; these are only conveniences.
    }
}

function isNarrowScreen() {
    return browser.matchMedia("(max-width: 767.98px)").matches;
}

function timeOf(value) {
    return deserializeDateTime(value).toMillis();
}

const SORTERS = {
    name: (a, b) => a.name.localeCompare(b.name),
    name_desc: (a, b) => b.name.localeCompare(a.name),
    created: (a, b) => timeOf(a.create_date) - timeOf(b.create_date),
    created_desc: (a, b) => timeOf(b.create_date) - timeOf(a.create_date),
    updated_desc: (a, b) => timeOf(b.write_date) - timeOf(a.write_date),
    likes_desc: (a, b) => (b.likes_count || 0) - (a.likes_count || 0),
    views_desc: (a, b) => (b.views_count || 0) - (a.views_count || 0),
};

export class KnowledgeWorkspace extends Component {
    static template = "cl_knowledge_management.KnowledgeWorkspace";
    static components = { ArticleComments, CheckBox, Dropdown, DropdownItem, Wysiwyg };

    props = useProps(standardActionServiceProps);

    SORT_OPTIONS = [
        { value: "name", label: _t("Name (A → Z)") },
        { value: "name_desc", label: _t("Name (Z → A)") },
        { value: "updated_desc", label: _t("Last updated") },
        { value: "created_desc", label: _t("Newest first") },
        { value: "created", label: _t("Oldest first") },
        { value: "likes_desc", label: _t("Most liked") },
        { value: "views_desc", label: _t("Most viewed") },
    ];

    contentRef = signal.ref();
    rootRef = signal.ref();

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.dialog = useService("dialog");
        this.notification = useService("notification");

        this.currentUserId = user.userId;
        this.detailCache = new Map();
        this.viewedIds = new Set();
        this.loadToken = 0;
        this.editor = null;
        this.editorConfig = null;
        this.editorDirty = false;
        this.resizing = false;

        this.state = proxy({
            loading: true,
            detailLoading: false,
            articles: [],
            tags: [],
            favorites: {},
            currentId: null,
            detail: null,
            collapsed: readStorage("collapsed", {}),
            sortOrder: readStorage("sort", "name"),
            onlyFavorites: readStorage("only_favorites", false),
            showArchived: readStorage("show_archived", false),
            selectedTags: readStorage("selected_tags", []),
            tagSearch: "",
            sidebarCollapsed: isNarrowScreen() || readStorage("sidebar_collapsed", false),
            sidebarWidth: readStorage("sidebar_width", SIDEBAR_DEFAULT_WIDTH),
            editing: false,
            editName: "",
            saving: false,
        });

        this.tagsById = computed(() => new Map(this.state.tags.map((tag) => [tag.id, tag])));
        this.articlesById = computed(() => new Map(this.state.articles.map((a) => [a.id, a])));
        this.visible = computed(() => this.computeVisible());
        this.rows = computed(() => this.computeRows());
        this.favoriteArticles = computed(() =>
            this.state.articles
                .filter((a) => a.active && this.state.favorites[a.id])
                .sort(SORTERS.name)
        );
        this.current = computed(() => this.articlesById().get(this.state.currentId) || null);
        this.breadcrumbs = computed(() => this.computeBreadcrumbs(this.state.currentId));
        this.parsedContent = computed(() => this.parseContent());

        onWillStart(() => this.loadWorkspace());

        useListener(document, "pointermove", (ev) => this.onResizeMove(ev));
        useListener(document, "pointerup", () => this.onResizeEnd());

        useSetupAction({
            beforeLeave: () => this.commitEditing(),
            beforeUnload: (ev) => {
                if (this.state.editing && this.editorDirty) {
                    ev.preventDefault();
                    ev.returnValue = "";
                }
            },
            getLocalState: () => ({ articleId: this.state.currentId }),
        });
    }

    // ------------------------------------------------------------------
    // Loading
    // ------------------------------------------------------------------

    async loadWorkspace() {
        await this.fetchWorkspace();
        this.state.loading = false;
        await this.openArticle(this.initialArticle(), { keepSidebar: true });
    }

    async fetchWorkspace() {
        const data = await this.orm.call("knowledge.article", "get_workspace_data", []);
        const previous = this.articlesById();
        this.state.articles = data.articles.map((record) => this.normalize(record, previous));
        this.state.tags = data.tags;
        this.state.favorites = Object.fromEntries(data.favorite_ids.map((id) => [id, true]));
    }

    normalize(record) {
        return { ...record, parent_id: record.parent_id ? record.parent_id[0] : null };
    }

    initialArticle() {
        const candidates = [
            this.props.state?.articleId,
            this.props.action.context?.article_id,
            this.props.action.context?.active_id,
            Number(router.current.article_id) || null,
            readStorage("last_article", null),
        ];
        const visibleIds = new Set(this.visible().list.map((a) => a.id));
        for (const id of candidates) {
            if (id && visibleIds.has(id)) {
                return this.articlesById().get(id);
            }
        }
        return this.rows()[0]?.article || null;
    }

    // ------------------------------------------------------------------
    // Derived data
    // ------------------------------------------------------------------

    /** The articles to show, each match kept with the ancestors that lead to it. */
    computeVisible() {
        const { articles, selectedTags, onlyFavorites, showArchived, favorites } = this.state;
        const byId = this.articlesById();
        const withAncestors = (seeds) => {
            const ids = new Set();
            for (const seed of seeds) {
                let node = seed;
                while (node && !ids.has(node.id)) {
                    ids.add(node.id);
                    node = byId.get(node.parent_id);
                }
            }
            return ids;
        };

        const scope = showArchived
            ? articles.filter((a) => withAncestors(articles.filter((x) => !x.active)).has(a.id))
            : articles.filter((a) => a.active);
        const matches = scope.filter(
            (a) =>
                (!selectedTags.length || a.tag_ids.some((id) => selectedTags.includes(id))) &&
                (!onlyFavorites || favorites[a.id])
        );
        const ids = withAncestors(matches);
        return {
            list: articles.filter((a) => ids.has(a.id)),
            tagMatches: new Set(selectedTags.length ? matches.map((a) => a.id) : []),
        };
    }

    /** Flatten the visible tree into rows, so the template needs no recursion. */
    computeRows() {
        const { list, tagMatches } = this.visible();
        const ids = new Set(list.map((a) => a.id));
        const children = new Map();
        for (const article of list) {
            // A parent the user cannot read must not hide its readable children.
            const key = ids.has(article.parent_id) ? article.parent_id : 0;
            children.set(key, [...(children.get(key) || []), article]);
        }
        const sorter = SORTERS[this.state.sortOrder] || SORTERS.name;
        const rows = [];
        const walk = (parentKey, depth) => {
            for (const article of (children.get(parentKey) || []).sort(sorter)) {
                const hasChildren = children.has(article.id);
                const expanded = hasChildren && !this.state.collapsed[article.id];
                rows.push({
                    article,
                    depth,
                    hasChildren,
                    expanded,
                    tagMatch: tagMatches.has(article.id),
                });
                if (expanded) {
                    walk(article.id, depth + 1);
                }
            }
        };
        walk(0, 0);
        return rows;
    }

    computeBreadcrumbs(articleId) {
        const byId = this.articlesById();
        const trail = [];
        let node = byId.get(articleId);
        while (node) {
            trail.unshift(node);
            node = byId.get(node.parent_id);
        }
        return trail;
    }

    parseContent() {
        const html = this.state.detail?.content || "";
        const doc = new DOMParser().parseFromString(html, "text/html");
        const text = (doc.body.textContent || "").trim();
        const words = text ? text.split(/\s+/).length : 0;
        return {
            markup: markup(html),
            empty: !text && !doc.querySelector("img, table, video, iframe"),
            headings: [...doc.querySelectorAll("h1, h2, h3")]
                .map((el, index) => ({
                    index,
                    level: Number(el.tagName[1]),
                    text: (el.textContent || "").trim(),
                }))
                .filter((heading) => heading.text),
            readingMinutes: Math.max(1, Math.ceil(words / WORDS_PER_MINUTE)),
        };
    }

    hasActiveFilters() {
        return (
            this.state.onlyFavorites || this.state.showArchived || this.state.selectedTags.length > 0
        );
    }

    activeFilterCount() {
        return (
            this.state.selectedTags.length +
            (this.state.onlyFavorites ? 1 : 0) +
            (this.state.showArchived ? 1 : 0)
        );
    }

    filteredTags() {
        const query = this.state.tagSearch.trim().toLowerCase();
        return this.state.tags.filter((tag) => tag.name.toLowerCase().includes(query));
    }

    currentTags() {
        const tags = this.tagsById();
        return (this.current()?.tag_ids || []).map((id) => tags.get(id)).filter(Boolean);
    }

    currentSortLabel() {
        return this.SORT_OPTIONS.find((o) => o.value === this.state.sortOrder)?.label;
    }

    isLiked() {
        return !!this.current()?.liked_by_ids.includes(this.currentUserId);
    }

    canEdit() {
        return !!this.state.detail?.can_edit && !!this.current()?.active;
    }

    relativeDate(value) {
        return value ? deserializeDateTime(value).toRelative() : "";
    }

    avatarUrl(userTuple) {
        return userTuple ? `/web/image/res.users/${userTuple[0]}/avatar_128` : "";
    }

    userName(userTuple) {
        return userTuple ? userTuple[1] : "";
    }

    // ------------------------------------------------------------------
    // Navigation
    // ------------------------------------------------------------------

    async openArticle(article, { keepSidebar = false } = {}) {
        if (this.state.editing && !(await this.commitEditing())) {
            return;
        }
        const token = ++this.loadToken;
        if (!article) {
            this.state.currentId = null;
            this.state.detail = null;
            return;
        }
        this.state.currentId = article.id;
        this.expandAncestors(article);
        if (!keepSidebar && isNarrowScreen()) {
            this.state.sidebarCollapsed = true;
        }
        writeStorage("last_article", article.id);
        this.props.updateActionState?.({ article_id: article.id });

        let detail = this.detailCache.get(article.id);
        if (!detail) {
            this.state.detailLoading = !this.state.detail;
            detail = await this.fetchDetail(article.id);
            if (token !== this.loadToken) {
                return;
            }
        }
        this.state.detail = detail;
        this.state.detailLoading = false;
        this.contentRef()?.scrollTo({ top: 0 });
        this.registerView(article);
    }

    async fetchDetail(articleId) {
        const detail = await this.orm.call("knowledge.article", "get_article_details", [[articleId]]);
        this.detailCache.set(articleId, detail);
        return detail;
    }

    registerView(article) {
        if (this.viewedIds.has(article.id)) {
            return;
        }
        this.viewedIds.add(article.id);
        browser.setTimeout(() => {
            rpc("/knowledge/article/increment_view", { article_id: article.id }, { silent: true });
            article.views_count = (article.views_count || 0) + 1;
        }, VIEW_DELAY);
    }

    expandAncestors(article) {
        for (const ancestor of this.computeBreadcrumbs(article.id).slice(0, -1)) {
            delete this.state.collapsed[ancestor.id];
        }
    }

    scrollToHeading(heading) {
        this.contentRef()
            ?.querySelectorAll(".o_knowledge_prose h1, .o_knowledge_prose h2, .o_knowledge_prose h3")
            [heading.index]?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    /** After a filter change the open article may be gone: fall back to the first row. */
    syncSelection() {
        const stillVisible = this.visible().list.some((a) => a.id === this.state.currentId);
        if (!stillVisible) {
            this.openArticle(this.rows()[0]?.article || null);
        }
    }

    // ------------------------------------------------------------------
    // Sidebar
    // ------------------------------------------------------------------

    toggleRow(row) {
        if (row.expanded) {
            this.state.collapsed[row.article.id] = true;
        } else {
            delete this.state.collapsed[row.article.id];
        }
        writeStorage("collapsed", this.state.collapsed);
    }

    expandAll() {
        this.state.collapsed = {};
        writeStorage("collapsed", {});
    }

    collapseAll() {
        const collapsed = {};
        for (const article of this.state.articles) {
            collapsed[article.id] = true;
        }
        this.state.collapsed = collapsed;
        writeStorage("collapsed", collapsed);
    }

    setSort(value) {
        this.state.sortOrder = value;
        writeStorage("sort", value);
    }

    toggleSidebar() {
        this.state.sidebarCollapsed = !this.state.sidebarCollapsed;
        writeStorage("sidebar_collapsed", this.state.sidebarCollapsed);
    }

    onResizeStart(ev) {
        if (this.state.sidebarCollapsed) {
            return;
        }
        ev.preventDefault();
        this.resizing = true;
        this.resizeOrigin = this.rootRef().getBoundingClientRect().left;
        document.body.classList.add("o_knowledge_resizing");
    }

    onResizeMove(ev) {
        if (this.resizing) {
            const width = Math.round(ev.clientX - this.resizeOrigin);
            this.state.sidebarWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
        }
    }

    onResizeEnd() {
        if (this.resizing) {
            this.resizing = false;
            document.body.classList.remove("o_knowledge_resizing");
            writeStorage("sidebar_width", this.state.sidebarWidth);
        }
    }

    // ------------------------------------------------------------------
    // Filters
    // ------------------------------------------------------------------

    toggleFavoritesFilter() {
        this.state.onlyFavorites = !this.state.onlyFavorites;
        writeStorage("only_favorites", this.state.onlyFavorites);
        this.syncSelection();
    }

    toggleArchivedFilter() {
        this.state.showArchived = !this.state.showArchived;
        writeStorage("show_archived", this.state.showArchived);
        this.syncSelection();
    }

    toggleTagFilter(tag) {
        const selected = this.state.selectedTags;
        this.state.selectedTags = selected.includes(tag.id)
            ? selected.filter((id) => id !== tag.id)
            : [...selected, tag.id];
        writeStorage("selected_tags", this.state.selectedTags);
        this.syncSelection();
    }

    clearFilters() {
        this.state.selectedTags = [];
        this.state.onlyFavorites = false;
        this.state.showArchived = false;
        writeStorage("selected_tags", []);
        writeStorage("only_favorites", false);
        writeStorage("show_archived", false);
        this.syncSelection();
    }

    openSearch() {
        this.dialog.add(KnowledgeSearchDialog, {
            articleIds: this.visible().list.map((a) => a.id),
            filtered: this.hasActiveFilters(),
            onOpen: (id) => this.openArticle(this.articlesById().get(id)),
        });
    }

    // ------------------------------------------------------------------
    // Reactions
    // ------------------------------------------------------------------

    async toggleLike() {
        const article = this.current();
        const result = await this.orm.call("knowledge.article", "action_toggle_like", [article.id]);
        article.liked_by_ids = result.liked_by_ids;
        article.likes_count = result.likes_count;
    }

    async toggleFavorite() {
        const article = this.current();
        const result = await this.orm.call("knowledge.article", "action_toggle_follow", [article.id]);
        if (result.following) {
            this.state.favorites[article.id] = true;
        } else {
            delete this.state.favorites[article.id];
        }
    }

    // ------------------------------------------------------------------
    // Editing
    // ------------------------------------------------------------------

    startEditing() {
        if (!this.canEdit()) {
            return;
        }
        const articleId = this.state.currentId;
        this.editorDirty = false;
        this.editorConfig = {
            content: markup(this.state.detail.content),
            Plugins: [...MAIN_PLUGINS, ...NO_EMBEDDED_COMPONENTS_FALLBACK_PLUGINS],
            allowVideo: false,
            baseContainers: ["DIV", "P"],
            direction: localization.direction || "ltr",
            dropImageAsAttachment: true,
            getRecordInfo: () => ({ resModel: "knowledge.article", resId: articleId }),
            onChange: () => {
                this.editorDirty = true;
            },
            placeholder: _t('Write something, or type "/" for commands'),
            resources: {},
        };
        this.state.editName = this.current().name;
        this.state.editing = true;
    }

    /** Save when something changed. Returns false if saving failed. */
    async commitEditing() {
        if (!this.state.editing || this.state.saving) {
            return !this.state.saving;
        }
        const article = this.current();
        const name = this.state.editName.trim();
        const values = {};
        if (name && name !== article.name) {
            values.name = name;
        }
        this.state.saving = true;
        try {
            if (this.editorDirty && this.editor) {
                const element = this.editor.getElContent();
                await this.editor.shared.imageSave?.savePendingImages(element);
                values.content = element.innerHTML;
            }
            if (Object.keys(values).length) {
                await this.orm.write("knowledge.article", [article.id], values);
                await this.refreshArticle(article.id);
            }
        } catch (error) {
            this.state.saving = false;
            throw error;
        }
        this.state.saving = false;
        this.stopEditing();
        return true;
    }

    discardEditing() {
        this.stopEditing();
    }

    stopEditing() {
        this.state.editing = false;
        this.editor = null;
        this.editorConfig = null;
        this.editorDirty = false;
    }

    async refreshArticle(articleId) {
        const [[record], detail] = await Promise.all([
            this.orm.read(
                "knowledge.article",
                [articleId],
                ["name", "display_name", "parent_id", "tag_ids", "write_date", "write_uid", "active"],
                { context: { active_test: false } }
            ),
            this.fetchDetail(articleId),
        ]);
        Object.assign(this.articlesById().get(articleId), this.normalize(record));
        if (this.state.currentId === articleId) {
            this.state.detail = detail;
        }
    }

    // ------------------------------------------------------------------
    // Article actions
    // ------------------------------------------------------------------

    newArticle(parent = null) {
        const location = parent ? this.computeBreadcrumbs(parent.id).map((a) => a.name).join(" / ") : "";
        this.dialog.add(KnowledgePromptDialog, {
            title: parent ? _t("New sub-article") : _t("New article"),
            label: _t("Title"),
            placeholder: _t("e.g. Onboarding guide"),
            hint: parent
                ? _t("Inside %(location)s. It inherits this article's access rights.", { location })
                : _t("Created at the top level of your workspace."),
            confirmLabel: _t("Create"),
            onConfirm: (title) => this.createArticle(title, parent),
        });
    }

    async createArticle(name, parent) {
        const [id] = await this.orm.create("knowledge.article", [
            { name, parent_id: parent?.id || false, is_published: true, active: true },
        ]);
        await this.fetchWorkspace();
        await this.openArticle(this.articlesById().get(id));
        this.startEditing();
    }

    rename() {
        const article = this.current();
        this.dialog.add(KnowledgePromptDialog, {
            title: _t("Rename article"),
            label: _t("Title"),
            value: article.name,
            confirmLabel: _t("Rename"),
            onConfirm: async (name) => {
                if (name !== article.name) {
                    await this.orm.write("knowledge.article", [article.id], { name });
                    await this.refreshArticle(article.id);
                }
            },
        });
    }

    moveArticle() {
        const article = this.current();
        const invalid = new Set([article.id]);
        const descend = (id) => {
            for (const child of this.state.articles.filter((a) => a.parent_id === id)) {
                invalid.add(child.id);
                descend(child.id);
            }
        };
        descend(article.id);
        this.dialog.add(KnowledgeMoveDialog, {
            article,
            articles: this.state.articles.filter((a) => a.active),
            invalidIds: invalid,
            onConfirm: async (parentId) => {
                await this.orm.write("knowledge.article", [article.id], { parent_id: parentId || false });
                article.parent_id = parentId;
                await this.refreshArticle(article.id);
                this.expandAncestors(article);
                this.notification.add(_t("Article moved"), { type: "success" });
            },
        });
    }

    editTags() {
        const article = this.current();
        this.dialog.add(KnowledgeTagsDialog, {
            tags: this.state.tags,
            selected: article.tag_ids,
            onConfirm: async (ids) => {
                await this.orm.write("knowledge.article", [article.id], { tag_ids: [[6, 0, ids]] });
                article.tag_ids = ids;
                this.syncSelection();
            },
        });
    }

    archive() {
        this.dialog.add(ConfirmationDialog, {
            title: _t("Archive article?"),
            body: _t('You can still find it with the "Archived" filter and restore it later.'),
            confirmLabel: _t("Archive"),
            confirmClass: "btn-danger",
            confirm: () => this.setActive(false),
            cancel: () => {},
            cancelLabel: _t("Cancel"),
        });
    }

    unarchive() {
        return this.setActive(true);
    }

    async setActive(active) {
        const article = this.current();
        await this.orm.write("knowledge.article", [article.id], { active });
        article.active = active;
        this.detailCache.delete(article.id);
        this.notification.add(active ? _t("Article restored") : _t("Article archived"), {
            type: "success",
        });
        if (this.visible().list.some((a) => a.id === article.id)) {
            await this.openArticle(article);
        } else {
            this.syncSelection();
        }
    }

    duplicate() {
        const article = this.current();
        this.dialog.add(KnowledgePromptDialog, {
            title: _t("Duplicate article"),
            label: _t("Title of the copy"),
            value: _t("%(name)s (copy)", { name: article.name }),
            confirmLabel: _t("Duplicate"),
            onConfirm: (name) => this.createCopy(article, name),
        });
    }

    async createCopy(article, name) {
        const [id] = await this.orm.create("knowledge.article", [
            {
                name,
                content: this.state.detail.content,
                tag_ids: article.tag_ids.map((tagId) => [4, tagId]),
                parent_id: article.parent_id || false,
                is_published: true,
                active: true,
            },
        ]);
        await this.fetchWorkspace();
        await this.openArticle(this.articlesById().get(id));
        this.notification.add(_t("Article duplicated"), { type: "success" });
    }

    async share() {
        const url = `${browser.location.origin}/knowledge/article/${this.current().share_token}`;
        try {
            await browser.navigator.clipboard.writeText(url);
            this.notification.add(_t("Public link copied to clipboard"), { type: "success" });
        } catch {
            // The clipboard API only exists on HTTPS: show the link instead.
            this.dialog.add(KnowledgePromptDialog, {
                title: _t("Public link"),
                label: _t("Anyone with this link can read the article"),
                value: url,
                readonly: true,
                confirmLabel: _t("Close"),
                onConfirm: () => {},
            });
        }
    }

    exportArticle() {
        const article = this.current();
        const printWindow = browser.open("", "_blank");
        if (!printWindow) {
            this.notification.add(_t("Allow pop-ups to export this article."), { type: "warning" });
            return;
        }
        const doc = printWindow.document;
        doc.title = article.name;
        const style = doc.createElement("style");
        style.textContent =
            "body{font:15px/1.65 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1f2933}" +
            "img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.4rem}" +
            "h1.o_title{margin-bottom:.25rem}.o_meta{color:#667085;font-size:12px;margin-bottom:2rem}";
        doc.head.appendChild(style);
        const title = doc.createElement("h1");
        title.className = "o_title";
        title.textContent = article.name;
        const meta = doc.createElement("div");
        meta.className = "o_meta";
        meta.textContent = _t("Created by %(creator)s · Last edited by %(editor)s %(date)s", {
            creator: this.userName(article.create_uid),
            editor: this.userName(article.write_uid),
            date: this.relativeDate(article.write_date),
        });
        const body = doc.createElement("div");
        body.innerHTML = this.state.detail.content;
        doc.body.append(title, meta, body);
        printWindow.focus();
        printWindow.print();
    }

    openVersions() {
        const article = this.current();
        this.dialog.add(KnowledgeVersionsDialog, {
            article,
            currentVersion: this.state.detail.version,
        });
    }

    openSettings() {
        this.action.doAction({
            type: "ir.actions.act_window",
            res_model: "knowledge.article",
            res_id: this.state.currentId,
            views: [[false, "form"]],
            target: "current",
        });
    }
}

registry.category("actions").add("knowledge_split_client", KnowledgeWorkspace);
