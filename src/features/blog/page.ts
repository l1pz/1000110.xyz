import { bootPage } from "../../core/boot";
import { escapeHtml } from "../../core/html";
import { isoDate, renderPage } from "../../core/shell";
import { crumbTrail, getPage } from "../../core/site";
import { highlightBlocks } from "./code";
import type { Post } from "./frontmatter";
import { renderMarkdown } from "./markdown";
import { getPost, getPosts } from "./posts";
import { postRows } from "./rows";

export type Route = { view: "index" } | { view: "post"; slug: string };

/** `/blog/` is the list, `/blog/#<slug>` is one post. */
export function parseRoute(hash: string): Route {
    const slug = decodeURIComponent(hash.replace(/^#/, ""));
    return slug === "" ? { view: "index" } : { view: "post", slug };
}

const blog = () => getPage("blog");
/** Crumbs for a page inside the blog: the "blog" crumb goes back to the list (an in-page hash change). */
const trail = (slug: string) => crumbTrail(blog(), slug, "#");

/** The `/blog/` list, drawn like `ls -l`. `today` is the man header date. */
export function renderIndex(posts: Post[], today: string): string {
    return renderPage({
        page: blog(),
        command: "ls -l ~/blog",
        date: today,
        body: `<p class="dim">total ${posts.length}</p>\n${postRows(posts)}`,
        secret: "keep writing",
    });
}

/** One post, with the post's own date and optional `secret`. */
export function renderPost(post: Post): string {
    const tags = post.tags.length ? `<p class="dim">tags: ${escapeHtml(post.tags.join(", "))}</p>` : "";
    return renderPage({
        page: blog(),
        trail: trail(post.slug),
        name: post.slug,
        command: `cat posts/${post.slug}.md`,
        date: post.date,
        body: [
            `<h1 class="title">${escapeHtml(post.title)}</h1>`,
            tags,
            `<article>${renderMarkdown(post.body)}</article>`,
        ].join("\n"),
        secret: post.secret,
    });
}

export function renderNotFound(slug: string, today: string): string {
    return renderPage({
        page: blog(),
        trail: trail(slug),
        name: "error",
        command: `cat posts/${slug}.md`,
        date: today,
        body: [
            `<p class="error">cat: posts/${escapeHtml(slug)}.md: no such file</p>`,
            '<p><a href="#">cd ~/blog</a></p>',
        ].join("\n"),
    });
}

/** Draws the page into `el` and wires up the hash routing, the shared status line and the shared keys. */
export async function mount(el: Element): Promise<void> {
    el.innerHTML = '<main id="content" class="page"></main>';
    const content = el.querySelector<HTMLElement>("#content");
    if (!content) return;

    // "up" from a post is the list; from the list it is home (the default).
    const status = bootPage(blog(), {
        up: () => {
            if (location.hash) location.hash = "";
            else location.href = "/";
        },
    });

    const show = () => {
        const today = isoDate(new Date());
        const route = parseRoute(location.hash);
        if (route.view === "index") {
            content.innerHTML = renderIndex(getPosts(), today);
            document.title = "blog - 1000110.xyz";
        } else {
            const post = getPost(route.slug);
            content.innerHTML = post ? renderPost(post) : renderNotFound(route.slug, today);
            document.title = `${post ? post.title : "not found"} - 1000110.xyz`;
        }
        window.scrollTo(0, 0);
        status.update();
        void highlightBlocks(content);
    };

    window.addEventListener("hashchange", show);
    show();
}
