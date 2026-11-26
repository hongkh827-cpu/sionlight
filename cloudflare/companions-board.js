// Place this function below the existing worker.js code.
// Route /companions to it inside the existing fetch handler.
async function companionsBoard(request, env) {
  const url = new URL(request.url);
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  };
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]
  );
  const page = (content, status = 200) => new Response(
    '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>삶의 동행 | ZIONLIGHT</title><style>body{background:#101b2c;color:#f6e9d2;font:16px/1.7 system-ui;margin:0;padding:24px}main{max-width:650px;margin:auto}a{color:#f0cf96}article,section{border:1px solid #50617b;border-radius:12px;padding:16px;margin:18px 0}textarea,input,button{font:inherit}textarea{display:block;box-sizing:border-box;width:100%;margin:8px 0;background:#1b2b42;color:inherit;padding:8px}button{padding:6px 14px}p{overflow-wrap:anywhere;white-space:pre-wrap}</style>' +
    '<main><a href="https://hongkh827-cpu.github.io/sionlight/companions.html">삶의 동행 안내</a><h1>삶의 동행</h1>' +
    '<p>삶의 동행은 만 19세 이상 성인을 위한 공간입니다.</p>' + content + '</main></html>',
    { status, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } }
  );
  const method = request.method;
  if (method !== "GET" && method !== "POST") return page("<p>지원하지 않는 요청입니다.</p>", 405);
  if (method === "POST" && request.headers.get("Origin") !== url.origin) {
    return page("<p>요청을 확인할 수 없습니다.</p>", 403);
  }
  const sessionId = cookieValue(request, "sionlight_session");
  const member = sessionId && await env.DB.prepare(
    "SELECT m.id, m.nickname FROM member_sessions s JOIN members m ON m.id = s.member_id WHERE s.id = ? AND s.expires_at > ? AND m.status IN ('pending', 'active')"
  ).bind(sessionId, Date.now()).first();

  if (!member) {
    return page('<p>자기소개를 읽고 글과 댓글을 쓰려면 로그인해 주세요.</p><a href="/auth/kakao">카카오로 로그인</a>', method === "POST" ? 401 : 200);
  }

  const db = env.DB;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS companion_board_agreements (member_id TEXT PRIMARY KEY, agreed_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS companion_board_posts (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS companion_board_comments (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, member_id TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS companion_board_comments_post ON companion_board_comments(post_id, created_at)")
  ]);
  const agreement = await db.prepare("SELECT member_id FROM companion_board_agreements WHERE member_id = ?")
    .bind(member.id).first();

  if (method === "POST") {
    const type = request.headers.get("Content-Type") || "";
    if (!type.startsWith("application/x-www-form-urlencoded")) return page("<p>양식을 확인해 주세요.</p>", 415);
    const form = new URLSearchParams(await request.text());
    const action = form.get("action");
    if (action === "agree" && form.get("rules") === "yes") {
      await db.prepare("INSERT OR IGNORE INTO companion_board_agreements VALUES (?, ?)").bind(member.id, Date.now()).run();
    } else if (agreement && (action === "post" || action === "comment")) {
      const body = (form.get("body") || "").trim();
      if (!body || body.length > (action === "post" ? 1000 : 500)) {
        return page('<p>글의 길이를 확인해 주세요.</p><a href="/companions">게시판으로 돌아가기</a>', 400);
      }
      const id = crypto.randomUUID();
      if (action === "post") {
        await db.prepare("INSERT INTO companion_board_posts VALUES (?, ?, ?, ?)").bind(id, member.id, body, Date.now()).run();
      } else {
        const postId = form.get("post");
        const result = await db.prepare(
          "INSERT INTO companion_board_comments SELECT ?, id, ?, ?, ? FROM companion_board_posts WHERE id = ?"
        ).bind(id, member.id, body, Date.now(), postId).run();
        if (!result.meta.changes) return page('<p>게시글을 찾을 수 없습니다.</p><a href="/companions">게시판으로 돌아가기</a>', 404);
        return new Response(null, { status: 303, headers: { ...headers, Location: "/companions?post=" + encodeURIComponent(postId) } });
      }
    } else {
      return page('<p>이용수칙에 먼저 동의해 주세요.</p><a href="/companions">게시판으로 돌아가기</a>', 403);
    }
    return new Response(null, { status: 303, headers: { ...headers, Location: "/companions" } });
  }

  if (!agreement) {
    return page('<form method="post" action="/companions"><input type="hidden" name="action" value="agree">' +
      '<p><a href="https://hongkh827-cpu.github.io/sionlight/companions.html" target="_blank" rel="noopener">이용수칙 읽기</a></p>' +
      '<label><input type="checkbox" name="rules" value="yes" required> 이용수칙을 읽었으며 준수하는 데 동의합니다.</label><p><button>동의하고 입장</button></p></form>');
  }

  const postId = url.searchParams.get("post");
  if (postId) {
    const post = await db.prepare(
      "SELECT p.id, p.body, m.nickname FROM companion_board_posts p JOIN members m ON m.id = p.member_id WHERE p.id = ?"
    ).bind(postId).first();
    if (!post) return page('<p>게시글을 찾을 수 없습니다.</p><a href="/companions">게시판으로 돌아가기</a>', 404);
    const comments = await db.prepare(
      "SELECT c.body, m.nickname FROM companion_board_comments c JOIN members m ON m.id = c.member_id WHERE c.post_id = ? ORDER BY c.created_at, c.id LIMIT 100"
    ).bind(postId).all();
    return page('<a href="/companions">목록으로 돌아가기</a><article><strong>' + escape(post.nickname) + '</strong><p>' + escape(post.body) + '</p></article><h2>댓글</h2>' +
      comments.results.map((comment) => '<article><strong>' + escape(comment.nickname) + '</strong><p>' + escape(comment.body) + '</p></article>').join("") +
      '<form method="post" action="/companions"><input type="hidden" name="action" value="comment"><input type="hidden" name="post" value="' + escape(post.id) +
      '"><label>댓글<textarea name="body" maxlength="500" required rows="3"></textarea></label><button>댓글 올리기</button></form>');
  }

  const posts = await db.prepare(
    "SELECT p.id, p.body, m.nickname FROM companion_board_posts p JOIN members m ON m.id = p.member_id ORDER BY p.created_at DESC, p.id LIMIT 100"
  ).all();
  return page('<section><h2>자기소개 올리기</h2><p>전화번호, 주소, 외부 연락처는 적지 마세요.</p>' +
    '<form method="post" action="/companions"><input type="hidden" name="action" value="post"><label>자기소개<textarea name="body" maxlength="1000" required rows="5"></textarea></label><button>글 올리기</button></form></section><h2>회원 자기소개</h2>' +
    (posts.results.length ? posts.results.map((post) => '<article><strong>' + escape(post.nickname) + '</strong><p>' + escape(post.body.slice(0, 180)) +
      '</p><a href="/companions?post=' + encodeURIComponent(post.id) + '">자기소개와 댓글 보기</a></article>').join("") : '<p>아직 올라온 자기소개가 없습니다.</p>'));
}
