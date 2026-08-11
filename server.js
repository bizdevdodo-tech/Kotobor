const express = require("express");
const { Pool } = require("pg");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const crypto = require("crypto");

require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  "/api/",
  rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use(express.static(path.join(__dirname, "public")));

const FIVE_HOURS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

const BASE_LIMIT = 5;
const CAT_LIMIT = 10;
const SHARE_BONUS = 5;
const REFERRALS_FOR_UNLIMITED = 10;

function now() {
  return new Date();
}

function safeUser(user) {
  return {
    id: user.id,
    telegramUserId: user.telegram_user_id,
    username: user.username,
    firstName: user.first_name,
    role: user.role,
    status: user.status,
  };
}

/*
  TELEGRAM INIT DATA VALIDATION

  В production пользователь определяется ТОЛЬКО через подписанный
  Telegram initData.

  DEV_USER_ID разрешён исключительно если DEV_MODE=true.
*/

function validateTelegramInitData(initData) {
  if (!initData || !process.env.TELEGRAM_BOT_TOKEN) {
    return null;
  }

  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");

    if (!receivedHash) return null;

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(process.env.TELEGRAM_BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    const a = Buffer.from(calculatedHash, "hex");
    const b = Buffer.from(receivedHash, "hex");

    if (a.length !== b.length) return null;

    if (!crypto.timingSafeEqual(a, b)) {
      return null;
    }

    const authDate = Number(params.get("auth_date"));

    if (
      !authDate ||
      Math.abs(Date.now() / 1000 - authDate) > 24 * 60 * 60
    ) {
      return null;
    }

    const rawUser = params.get("user");

    if (!rawUser) return null;

    return JSON.parse(rawUser);
  } catch (error) {
    console.error("Telegram validation error:", error);
    return null;
  }
}

async function getOrCreateUser(telegramUser) {
  const telegramId = String(telegramUser.id);

  let result = await pool.query(
    `SELECT * FROM users WHERE telegram_user_id = $1`,
    [telegramId]
  );

  if (result.rows.length) {
    const updated = await pool.query(
      `
      UPDATE users
      SET
        username = $2,
        first_name = $3,
        last_name = $4,
        updated_at = NOW()
      WHERE telegram_user_id = $1
      RETURNING *
      `,
      [
        telegramId,
        telegramUser.username || null,
        telegramUser.first_name || null,
        telegramUser.last_name || null,
      ]
    );

    return updated.rows[0];
  }

  const created = await pool.query(
    `
    INSERT INTO users (
      telegram_user_id,
      username,
      first_name,
      last_name
    )
    VALUES ($1,$2,$3,$4)
    RETURNING *
    `,
    [
      telegramId,
      telegramUser.username || null,
      telegramUser.first_name || null,
      telegramUser.last_name || null,
    ]
  );

  return created.rows[0];
}

async function auth(req, res, next) {
  try {
    let telegramUser = null;

    const initData = req.headers["x-telegram-init-data"];

    if (initData) {
      telegramUser = validateTelegramInitData(initData);
    }

    if (
      !telegramUser &&
      process.env.DEV_MODE === "true" &&
      process.env.DEV_USER_ID
    ) {
      telegramUser = {
        id: process.env.DEV_USER_ID,
        username: "dev_owner",
        first_name: "Owner",
      };
    }

    if (!telegramUser) {
      return res.status(401).json({
        error: "TELEGRAM_AUTH_REQUIRED",
      });
    }

    const user = await getOrCreateUser(telegramUser);

    if (user.status === "PERMANENT_BAN") {
      return res.status(403).json({
        error: "PERMANENT_BAN",
        message:
          "Ваш аккаунт навсегда заблокирован за грубое нарушение правил сервиса.",
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "AUTH_ERROR" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: "ACCESS_DENIED",
      });
    }

    next();
  };
}

/* ---------- DATABASE ---------- */

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      telegram_user_id TEXT UNIQUE NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,

      role TEXT NOT NULL DEFAULT 'USER'
        CHECK (role IN ('USER','MODERATOR','OWNER')),

      status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE','PERMANENT_BAN')),

      referred_by BIGINT REFERENCES users(id),

      unlimited_until TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cats (
      id BIGSERIAL PRIMARY KEY,

      owner_id BIGINT NOT NULL REFERENCES users(id),

      name TEXT NOT NULL,

      image_url TEXT NOT NULL,

      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (
          status IN (
            'PENDING',
            'APPROVED',
            'REJECTED',
            'HIDDEN'
          )
        ),

      rating DOUBLE PRECISION NOT NULL DEFAULT 1000,

      battles INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,

      calibration_battles INTEGER NOT NULL DEFAULT 0,

      approved_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS votes (
      id BIGSERIAL PRIMARY KEY,

      user_id BIGINT NOT NULL REFERENCES users(id),

      cat_a_id BIGINT NOT NULL REFERENCES cats(id),
      cat_b_id BIGINT NOT NULL REFERENCES cats(id),

      winner_id BIGINT NOT NULL REFERENCES cats(id),
      loser_id BIGINT NOT NULL REFERENCES cats(id),

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS vote_windows (
      user_id BIGINT PRIMARY KEY REFERENCES users(id),

      window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      votes_used INTEGER NOT NULL DEFAULT 0,

      bonus_votes INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS share_rewards (
      id BIGSERIAL PRIMARY KEY,

      user_id BIGINT NOT NULL REFERENCES users(id),

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS referrals (
      id BIGSERIAL PRIMARY KEY,

      inviter_id BIGINT NOT NULL REFERENCES users(id),
      invited_id BIGINT UNIQUE NOT NULL REFERENCES users(id),

      confirmed BOOLEAN NOT NULL DEFAULT FALSE,

      confirmed_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS moderation_actions (
      id BIGSERIAL PRIMARY KEY,

      moderator_id BIGINT NOT NULL REFERENCES users(id),

      target_user_id BIGINT REFERENCES users(id),
      cat_id BIGINT REFERENCES cats(id),

      action TEXT NOT NULL,

      reason TEXT,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reports (
      id BIGSERIAL PRIMARY KEY,

      reporter_id BIGINT NOT NULL REFERENCES users(id),
      cat_id BIGINT NOT NULL REFERENCES cats(id),

      reason TEXT,

      status TEXT NOT NULL DEFAULT 'OPEN'
        CHECK (
          status IN (
            'OPEN',
            'RESOLVED',
            'DISMISSED'
          )
        ),

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_cats_status
    ON cats(status);

    CREATE INDEX IF NOT EXISTS idx_cats_rating
    ON cats(rating DESC);

    CREATE INDEX IF NOT EXISTS idx_votes_user
    ON votes(user_id);

    CREATE INDEX IF NOT EXISTS idx_votes_created
    ON votes(created_at);

    CREATE INDEX IF NOT EXISTS idx_referrals_inviter
    ON referrals(inviter_id);
  `);

  console.log("Database initialized");
}

/* ---------- VOTE LIMIT ---------- */

async function hasApprovedCat(userId) {
  const result = await pool.query(
    `
    SELECT 1
    FROM cats
    WHERE owner_id = $1
      AND status = 'APPROVED'
    LIMIT 1
    `,
    [userId]
  );

  return result.rows.length > 0;
}

async function getVoteState(user) {
  const currentTime = now();

  if (
    user.unlimited_until &&
    new Date(user.unlimited_until) > currentTime
  ) {
    return {
      unlimited: true,
      remaining: null,
      resetsAt: null,
    };
  }

  const approvedCat = await hasApprovedCat(user.id);

  const baseLimit = approvedCat ? CAT_LIMIT : BASE_LIMIT;

  let result = await pool.query(
    `
    SELECT *
    FROM vote_windows
    WHERE user_id = $1
    `,
    [user.id]
  );

  if (!result.rows.length) {
    result = await pool.query(
      `
      INSERT INTO vote_windows (
        user_id,
        window_started_at,
        votes_used,
        bonus_votes
      )
      VALUES ($1,NOW(),0,0)
      RETURNING *
      `,
      [user.id]
    );
  }

  let window = result.rows[0];

  const started = new Date(window.window_started_at);

  if (currentTime - started >= FIVE_HOURS) {
    const reset = await pool.query(
      `
      UPDATE vote_windows
      SET
        window_started_at = NOW(),
        votes_used = 0,
        bonus_votes = 0
      WHERE user_id = $1
      RETURNING *
      `,
      [user.id]
    );

    window = reset.rows[0];
  }

  const totalAvailable =
    baseLimit + Number(window.bonus_votes);

  const remaining = Math.max(
    0,
    totalAvailable - Number(window.votes_used)
  );

  return {
    unlimited: false,
    baseLimit,
    bonusVotes: Number(window.bonus_votes),
    used: Number(window.votes_used),
    remaining,
    resetsAt: new Date(
      new Date(window.window_started_at).getTime() + FIVE_HOURS
    ),
  };
}

async function consumeVote(user) {
  const state = await getVoteState(user);

  if (state.unlimited) {
    return state;
  }

  if (state.remaining <= 0) {
    const error = new Error("VOTE_LIMIT");
    error.code = "VOTE_LIMIT";
    error.state = state;
    throw error;
  }

  await pool.query(
    `
    UPDATE vote_windows
    SET votes_used = votes_used + 1
    WHERE user_id = $1
    `,
    [user.id]
  );

  return getVoteState(user);
}

/* ---------- ELO ---------- */

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function kFactor(cat) {
  if (cat.calibration_battles < 20) return 64;
  if (cat.battles < 50) return 40;
  return 24;
}

function calculateElo(winner, loser) {
  const expectedWinner = expectedScore(
    winner.rating,
    loser.rating
  );

  const expectedLoser = expectedScore(
    loser.rating,
    winner.rating
  );

  const winnerNew =
    winner.rating +
    kFactor(winner) * (1 - expectedWinner);

  const loserNew =
    loser.rating +
    kFactor(loser) * (0 - expectedLoser);

  return {
    winnerRating: winnerNew,
    loserRating: loserNew,
  };
}

/* ---------- PROFILE ---------- */

app.get("/api/me", auth, async (req, res) => {
  try {
    const catResult = await pool.query(
      `
      SELECT *
      FROM cats
      WHERE owner_id = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [req.user.id]
    );

    const voteState = await getVoteState(req.user);

    const referrals = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM referrals
      WHERE inviter_id = $1
        AND confirmed = TRUE
      `,
      [req.user.id]
    );

    res.json({
      user: safeUser(req.user),
      cat: catResult.rows[0] || null,
      votes: voteState,
      referrals: {
        confirmed: referrals.rows[0].count,
        target: REFERRALS_FOR_UNLIMITED,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "PROFILE_ERROR" });
  }
});

/* ---------- SHARE BONUS ---------- */

app.post("/api/share-reward", auth, async (req, res) => {
  try {
    const previous = await pool.query(
      `
      SELECT created_at
      FROM share_rewards
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [req.user.id]
    );

    if (previous.rows.length) {
      const last = new Date(previous.rows[0].created_at);

      if (now() - last < FIVE_HOURS) {
        return res.status(409).json({
          error: "SHARE_COOLDOWN",
          availableAt: new Date(
            last.getTime() + FIVE_HOURS
          ),
        });
      }
    }

    await pool.query("BEGIN");

    await pool.query(
      `
      INSERT INTO share_rewards (user_id)
      VALUES ($1)
      `,
      [req.user.id]
    );

    await getVoteState(req.user);

    await pool.query(
      `
      UPDATE vote_windows
      SET bonus_votes = bonus_votes + $2
      WHERE user_id = $1
      `,
      [req.user.id, SHARE_BONUS]
    );

    await pool.query("COMMIT");

    res.json({
      success: true,
      bonus: SHARE_BONUS,
      votes: await getVoteState(req.user),
    });
  } catch (error) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error(error);
    res.status(500).json({ error: "SHARE_ERROR" });
  }
});

/* ---------- BATTLE ---------- */

app.get("/api/battle", auth, async (req, res) => {
  try {
    const state = await getVoteState(req.user);

    if (!state.unlimited && state.remaining <= 0) {
      return res.status(429).json({
        error: "VOTE_LIMIT",
        votes: state,
      });
    }

    const candidates = await pool.query(
      `
      SELECT c.*
      FROM cats c
      WHERE c.status = 'APPROVED'
        AND c.owner_id <> $1

        AND NOT EXISTS (
          SELECT 1
          FROM votes v
          WHERE v.user_id = $1
            AND (
              v.cat_a_id = c.id
              OR v.cat_b_id = c.id
            )
        )

      ORDER BY
        CASE
          WHEN c.calibration_battles < 20
          THEN random() * 0.55
          ELSE 0.55 + random() * 0.45
        END

      LIMIT 30
      `,
      [req.user.id]
    );

    if (candidates.rows.length < 2) {
      return res.status(404).json({
        error: "NO_BATTLE_AVAILABLE",
      });
    }

    const first =
      candidates.rows[
        Math.floor(Math.random() * candidates.rows.length)
      ];

    const others = candidates.rows.filter(
      (cat) => cat.id !== first.id
    );

    others.sort(
      (a, b) =>
        Math.abs(a.rating - first.rating) -
        Math.abs(b.rating - first.rating)
    );

    let second;

    const randomMode = Math.random();

    if (randomMode < 0.5) {
      // ~50% близкий рейтинг
      second =
        others[
          Math.floor(
            Math.random() *
              Math.min(5, others.length)
          )
        ];
    } else if (randomMode < 0.8) {
      // ~30% приоритет калибровочным
      second =
        others.find(
          (cat) => cat.calibration_battles < 20
        ) || others[0];
    } else {
      // ~20% широкая случайная выборка
      second =
        others[
          Math.floor(Math.random() * others.length)
        ];
    }

    res.json({
      cats: [
        {
          id: first.id,
          name: first.name,
          imageUrl: first.image_url,
        },
        {
          id: second.id,
          name: second.name,
          imageUrl: second.image_url,
        },
      ],
      votes: state,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "BATTLE_ERROR" });
  }
});

app.post("/api/vote", auth, async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      catAId,
      catBId,
      winnerId,
    } = req.body;

    if (
      !catAId ||
      !catBId ||
      !winnerId ||
      catAId === catBId ||
      ![String(catAId), String(catBId)].includes(
        String(winnerId)
      )
    ) {
      return res.status(400).json({
        error: "INVALID_VOTE",
      });
    }

    await client.query("BEGIN");

    const catsResult = await client.query(
      `
      SELECT *
      FROM cats
      WHERE id = ANY($1::bigint[])
        AND status = 'APPROVED'
      FOR UPDATE
      `,
      [[catAId, catBId]]
    );

    if (catsResult.rows.length !== 2) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "CATS_NOT_FOUND",
      });
    }

    if (
      catsResult.rows.some(
        (cat) =>
          String(cat.owner_id) ===
          String(req.user.id)
      )
    ) {
      await client.query("ROLLBACK");

      return res.status(403).json({
        error: "OWN_CAT_VOTE",
      });
    }

    const previousVote = await client.query(
      `
      SELECT 1
      FROM votes
      WHERE user_id = $1
        AND (
          (cat_a_id = $2 AND cat_b_id = $3)
          OR
          (cat_a_id = $3 AND cat_b_id = $2)
        )
      LIMIT 1
      `,
      [req.user.id, catAId, catBId]
    );

    if (previousVote.rows.length) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        error: "PAIR_ALREADY_VOTED",
      });
    }

    const winner = catsResult.rows.find(
      (cat) => String(cat.id) === String(winnerId)
    );

    const loser = catsResult.rows.find(
      (cat) => String(cat.id) !== String(winnerId)
    );

    const elo = calculateElo(winner, loser);

    await client.query(
      `
      INSERT INTO votes (
        user_id,
        cat_a_id,
        cat_b_id,
        winner_id,
        loser_id
      )
      VALUES ($1,$2,$3,$4,$5)
      `,
      [
        req.user.id,
        catAId,
        catBId,
        winner.id,
        loser.id,
      ]
    );

    await client.query(
      `
      UPDATE cats
      SET
        rating = $2,
        battles = battles + 1,
        wins = wins + 1,
        calibration_battles =
          LEAST(calibration_battles + 1, 20),
        updated_at = NOW()
      WHERE id = $1
      `,
      [winner.id, elo.winnerRating]
    );

    await client.query(
      `
      UPDATE cats
      SET
        rating = $2,
        battles = battles + 1,
        losses = losses + 1,
        calibration_battles =
          LEAST(calibration_battles + 1, 20),
        updated_at = NOW()
      WHERE id = $1
      `,
      [loser.id, elo.loserRating]
    );

    /*
      Реферал подтверждается первым настоящим голосованием.
    */

    const referral = await client.query(
      `
      UPDATE referrals
      SET
        confirmed = TRUE,
        confirmed_at = NOW()
      WHERE invited_id = $1
        AND confirmed = FALSE
      RETURNING inviter_id
      `,
      [req.user.id]
    );

    if (referral.rows.length) {
      const inviterId = referral.rows[0].inviter_id;

      const count = await client.query(
        `
        SELECT COUNT(*)::int AS count
        FROM referrals
        WHERE inviter_id = $1
          AND confirmed = TRUE
        `,
        [inviterId]
      );

      if (
        count.rows[0].count >=
        REFERRALS_FOR_UNLIMITED
      ) {
        await client.query(
          `
          UPDATE users
          SET unlimited_until =
            GREATEST(
              COALESCE(unlimited_until, NOW()),
              NOW()
            ) + INTERVAL '7 days'
          WHERE id = $1
          `,
          [inviterId]
        );
      }
    }

    await client.query("COMMIT");

    /*
      Лимит расходуем после успешной фиксации голоса.
    */

    const voteState = await consumeVote(req.user);

    res.json({
      success: true,
      votes: voteState,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});

    if (error.code === "VOTE_LIMIT") {
      return res.status(429).json({
        error: "VOTE_LIMIT",
        votes: error.state,
      });
    }

    console.error(error);

    res.status(500).json({
      error: "VOTE_ERROR",
    });
  } finally {
    client.release();
  }
});

/* ---------- CAT ---------- */

app.post("/api/cats", auth, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const imageUrl = String(
      req.body.imageUrl || ""
    ).trim();

    if (name.length < 1 || name.length > 40) {
      return res.status(400).json({
        error: "INVALID_CAT_NAME",
      });
    }

    /*
      На следующем шаге imageUrl заменим на реальную
      загрузку изображения в storage.
    */

    if (!imageUrl) {
      return res.status(400).json({
        error: "IMAGE_REQUIRED",
      });
    }

    const existing = await pool.query(
      `
      SELECT 1
      FROM cats
      WHERE owner_id = $1
        AND status IN ('PENDING','APPROVED')
      LIMIT 1
      `,
      [req.user.id]
    );

    if (existing.rows.length) {
      return res.status(409).json({
        error: "CAT_ALREADY_EXISTS",
      });
    }

    const result = await pool.query(
      `
      INSERT INTO cats (
        owner_id,
        name,
        image_url
      )
      VALUES ($1,$2,$3)
      RETURNING *
      `,
      [req.user.id, name, imageUrl]
    );

    res.status(201).json({
      success: true,
      cat: result.rows[0],
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "CAT_CREATE_ERROR" });
  }
});

/* ---------- RANKING ---------- */

app.get("/api/ranking", auth, async (req, res) => {
  try {
    const top = await pool.query(`
      SELECT
        id,
        name,
        image_url,
        rating,
        battles,
        wins,
        losses,

        RANK() OVER (
          ORDER BY rating DESC
        ) AS position

      FROM cats
      WHERE status = 'APPROVED'
        AND calibration_battles >= 20

      ORDER BY rating DESC
      LIMIT 100
    `);

    res.json({
      ranking: top.rows.map((cat) => ({
        ...cat,
        winRate:
          cat.battles > 0
            ? Math.round(
                (cat.wins / cat.battles) * 1000
              ) / 10
            : 0,
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "RANKING_ERROR" });
  }
});

app.get(
  "/api/my-cat-ranking",
  auth,
  async (req, res) => {
    try {
      const mine = await pool.query(
        `
        WITH ranked AS (
          SELECT
            c.*,
            RANK() OVER (
              ORDER BY rating DESC
            ) AS position,

            COUNT(*) OVER () AS total

          FROM cats c
          WHERE c.status = 'APPROVED'
            AND c.calibration_battles >= 20
        )

        SELECT *
        FROM ranked
        WHERE owner_id = $1
        LIMIT 1
        `,
        [req.user.id]
      );

      if (!mine.rows.length) {
        return res.json({
          calibrated: false,
        });
      }

      const cat = mine.rows[0];

      const around = await pool.query(
        `
        WITH ranked AS (
          SELECT
            id,
            owner_id,
            name,
            image_url,
            rating,
            battles,
            wins,
            losses,

            RANK() OVER (
              ORDER BY rating DESC
            ) AS position

          FROM cats
          WHERE status = 'APPROVED'
            AND calibration_battles >= 20
        )

        SELECT *
        FROM ranked
        WHERE position BETWEEN $1 AND $2
        ORDER BY position
        `,
        [
          Math.max(1, Number(cat.position) - 10),
          Number(cat.position) + 10,
        ]
      );

      const total = Number(cat.total);
      const position = Number(cat.position);

      const percentile =
        total <= 1
          ? 100
          : Math.max(
              0,
              Math.min(
                100,
                ((total - position) /
                  (total - 1)) *
                  100
              )
            );

      res.json({
        calibrated: true,
        position,
        total,
        percentile:
          Math.round(percentile * 10) / 10,
        around: around.rows,
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        error: "MY_RANKING_ERROR",
      });
    }
  }
);

/* ---------- REPORT ---------- */

app.post("/api/reports", auth, async (req, res) => {
  try {
    const { catId, reason } = req.body;

    const result = await pool.query(
      `
      INSERT INTO reports (
        reporter_id,
        cat_id,
        reason
      )
      VALUES ($1,$2,$3)
      RETURNING *
      `,
      [
        req.user.id,
        catId,
        String(reason || "").slice(0, 500),
      ]
    );

    res.status(201).json({
      success: true,
      report: result.rows[0],
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "REPORT_ERROR" });
  }
});

/* ---------- MODERATION ---------- */

app.get(
  "/api/admin/pending",
  auth,
  requireRole("MODERATOR", "OWNER"),
  async (req, res) => {
    const result = await pool.query(`
      SELECT
        c.*,
        u.telegram_user_id,
        u.username,
        u.first_name

      FROM cats c

      JOIN users u
        ON u.id = c.owner_id

      WHERE c.status = 'PENDING'

      ORDER BY c.created_at ASC
    `);

    res.json({
      cats: result.rows,
    });
  }
);

app.post(
  "/api/admin/cats/:id/approve",
  auth,
  requireRole("MODERATOR", "OWNER"),
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        UPDATE cats
        SET
          status = 'APPROVED',
          approved_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
          AND status = 'PENDING'
        RETURNING *
        `,
        [req.params.id]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          error: "PENDING_CAT_NOT_FOUND",
        });
      }

      await pool.query(
        `
        INSERT INTO moderation_actions (
          moderator_id,
          cat_id,
          target_user_id,
          action
        )
        VALUES ($1,$2,$3,'APPROVE')
        `,
        [
          req.user.id,
          result.rows[0].id,
          result.rows[0].owner_id,
        ]
      );

      res.json({
        success: true,
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        error: "APPROVE_ERROR",
      });
    }
  }
);

app.post(
  "/api/admin/cats/:id/reject",
  auth,
  requireRole("MODERATOR", "OWNER"),
  async (req, res) => {
    try {
      const reason = String(
        req.body.reason || "Другое"
      ).slice(0, 500);

      const result = await pool.query(
        `
        UPDATE cats
        SET
          status = 'REJECTED',
          updated_at = NOW()
        WHERE id = $1
          AND status = 'PENDING'
        RETURNING *
        `,
        [req.params.id]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          error: "PENDING_CAT_NOT_FOUND",
        });
      }

      await pool.query(
        `
        INSERT INTO moderation_actions (
          moderator_id,
          cat_id,
          target_user_id,
          action,
          reason
        )
        VALUES ($1,$2,$3,'REJECT',$4)
        `,
        [
          req.user.id,
          result.rows[0].id,
          result.rows[0].owner_id,
          reason,
        ]
      );

      res.json({
        success: true,
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        error: "REJECT_ERROR",
      });
    }
  }
);

app.post(
  "/api/admin/users/:id/permanent-ban",
  auth,
  requireRole("MODERATOR", "OWNER"),
  async (req, res) => {
    const client = await pool.connect();

    try {
      const reason = String(
        req.body.reason || ""
      ).slice(0, 500);

      if (!reason) {
        return res.status(400).json({
          error: "BAN_REASON_REQUIRED",
        });
      }

      if (
        String(req.params.id) ===
        String(req.user.id)
      ) {
        return res.status(400).json({
          error: "CANNOT_BAN_SELF",
        });
      }

      await client.query("BEGIN");

      const target = await client.query(
        `
        SELECT *
        FROM users
        WHERE id = $1
        FOR UPDATE
        `,
        [req.params.id]
      );

      if (!target.rows.length) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          error: "USER_NOT_FOUND",
        });
      }

      /*
        Модератор не может банить OWNER.
      */

      if (
        target.rows[0].role === "OWNER" &&
        req.user.role !== "OWNER"
      ) {
        await client.query("ROLLBACK");

        return res.status(403).json({
          error: "CANNOT_BAN_OWNER",
        });
      }

      await client.query(
        `
        UPDATE users
        SET
          status = 'PERMANENT_BAN',
          updated_at = NOW()
        WHERE id = $1
        `,
        [req.params.id]
      );

      await client.query(
        `
        UPDATE cats
        SET
          status = 'HIDDEN',
          updated_at = NOW()
        WHERE owner_id = $1
          AND status IN ('PENDING','APPROVED')
        `,
        [req.params.id]
      );

      await client.query(
        `
        INSERT INTO moderation_actions (
          moderator_id,
          target_user_id,
          action,
          reason
        )
        VALUES ($1,$2,'PERMANENT_BAN',$3)
        `,
        [
          req.user.id,
          req.params.id,
          reason,
        ]
      );

      await client.query("COMMIT");

      res.json({
        success: true,

        message: `⛔ Вы заблокированы навсегда.

Вы загрузили контент, который грубо нарушает правила сервиса.

Мы делали приложение, чтобы люди выбирали котиков, а не для того, что вы решили сюда принести.

Ваш аккаунт заблокирован без возможности дальнейшего использования сервиса.

Нам крайне неловко за ваше поведение и немного стыдно за то, как вас воспитали.

Всего недоброго. 🐈`,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(error);

      res.status(500).json({
        error: "BAN_ERROR",
      });
    } finally {
      client.release();
    }
  }
);

/* ---------- OWNER ---------- */

app.post(
  "/api/owner/users/:id/role",
  auth,
  requireRole("OWNER"),
  async (req, res) => {
    const role = req.body.role;

    if (!["USER", "MODERATOR"].includes(role)) {
      return res.status(400).json({
        error: "INVALID_ROLE",
      });
    }

    const result = await pool.query(
      `
      UPDATE users
      SET
        role = $2,
        updated_at = NOW()
      WHERE id = $1
        AND role <> 'OWNER'
      RETURNING id, role
      `,
      [req.params.id, role]
    );

    res.json({
      success: true,
      user: result.rows[0] || null,
    });
  }
);

app.post(
  "/api/owner/users/:id/unban",
  auth,
  requireRole("OWNER"),
  async (req, res) => {
    await pool.query(
      `
      UPDATE users
      SET
        status = 'ACTIVE',
        updated_at = NOW()
      WHERE id = $1
      `,
      [req.params.id]
    );

    await pool.query(
      `
      INSERT INTO moderation_actions (
        moderator_id,
        target_user_id,
        action
      )
      VALUES ($1,$2,'UNBAN')
      `,
      [req.user.id, req.params.id]
    );

    res.json({
      success: true,
    });
  }
);

/* ---------- HEALTH ---------- */

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      app: "КОТОБОР",
      database: true,
    });
  } catch {
    res.status(500).json({
      ok: false,
      database: false,
    });
  }
});

/* ---------- FRONTEND FALLBACK ---------- */

app.get("*", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

/* ---------- START ---------- */

async function start() {
  try {
    await initDatabase();

    /*
      Первый владелец задаётся через OWNER_TELEGRAM_ID.
      Никакой пользователь не может назначить себя OWNER через API.
    */

    if (process.env.OWNER_TELEGRAM_ID) {
      await pool.query(
        `
        UPDATE users
        SET role = 'OWNER'
        WHERE telegram_user_id = $1
        `,
        [String(process.env.OWNER_TELEGRAM_ID)]
      );
    }

    app.listen(PORT, "0.0.0.0", () => {
      console.log(
        `КОТОБОР запущен на порту ${PORT}`
      );
    });
  } catch (error) {
    console.error("Startup error:", error);
    process.exit(1);
  }
}

start();
