const express = require("express");
const { Pool } = require("pg");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const crypto = require("crypto");

require("dotenv").config();

/* =========================================================
   КОТОБОР
   Backend + Telegram Bot + PostgreSQL
   ========================================================= */

const app = express();
const PORT = process.env.PORT || 3000;

/*
  Railway стоит перед приложением как reverse proxy.
  Нужен trust proxy ДО express-rate-limit.
*/
app.set("trust proxy", 1);

/*
  Поддерживаем оба имени переменной:
  BOT_TOKEN — то, что уже добавлено в Railway.
  TELEGRAM_BOT_TOKEN — альтернативное имя.
*/
const TELEGRAM_BOT_TOKEN =
  process.env.BOT_TOKEN ||
  process.env.TELEGRAM_BOT_TOKEN ||
  "";

const APP_URL =
  process.env.APP_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : "https://kotobor-production.up.railway.app");

const OWNER_TELEGRAM_ID =
  process.env.OWNER_TELEGRAM_ID
    ? String(process.env.OWNER_TELEGRAM_ID)
    : null;

const FIVE_HOURS_MS =
  5 * 60 * 60 * 1000;

const BASE_LIMIT = 5;
const CAT_LIMIT = 10;
const SHARE_BONUS = 5;
const REFERRALS_FOR_UNLIMITED = 10;

const BAN_MESSAGE = `⛔ Вы заблокированы навсегда.

Вы загрузили контент, который грубо нарушает правила сервиса.

Мы делали приложение, чтобы люди выбирали котиков, а не для того, что вы решили сюда принести.

Ваш аккаунт заблокирован без возможности дальнейшего использования сервиса.

Нам крайне неловко за ваше поведение и немного стыдно за то, как вас воспитали.

Всего недоброго. 🐈`;

/* =========================================================
   POSTGRES
   ========================================================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

/* =========================================================
   EXPRESS
   ========================================================= */

app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

app.use(
  express.json({
    limit: "2mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
  })
);

app.use(
  "/api/",
  rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

/* =========================================================
   HELPERS
   ========================================================= */

function now() {
  return new Date();
}

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

function safeUser(user) {
  return {
    id: user.id,
    telegramUserId:
      user.telegram_user_id,
    username: user.username,
    firstName: user.first_name,
    lastName: user.last_name,
    role: user.role,
    status: user.status,
  };
}

function normalizeTelegramUser(user) {
  return {
    id: user.id,
    username:
      user.username || null,
    first_name:
      user.first_name || null,
    last_name:
      user.last_name || null,
  };
}

/* =========================================================
   DATABASE INITIALIZATION
   ========================================================= */

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,

      telegram_user_id TEXT UNIQUE NOT NULL,

      username TEXT,
      first_name TEXT,
      last_name TEXT,

      role TEXT NOT NULL DEFAULT 'USER'
        CHECK (
          role IN (
            'USER',
            'MODERATOR',
            'OWNER'
          )
        ),

      status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (
          status IN (
            'ACTIVE',
            'PERMANENT_BAN'
          )
        ),

      referred_by BIGINT
        REFERENCES users(id),

      unlimited_until TIMESTAMPTZ,

      referral_reward_granted_at
        TIMESTAMPTZ,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS
      referral_reward_granted_at
      TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS cats (
      id BIGSERIAL PRIMARY KEY,

      owner_id BIGINT
        NOT NULL
        REFERENCES users(id),

      name TEXT NOT NULL,

      image_url TEXT NOT NULL,

      status TEXT
        NOT NULL
        DEFAULT 'PENDING'
        CHECK (
          status IN (
            'PENDING',
            'APPROVED',
            'REJECTED',
            'HIDDEN'
          )
        ),

      rating DOUBLE PRECISION
        NOT NULL
        DEFAULT 1000,

      battles INTEGER
        NOT NULL
        DEFAULT 0,

      wins INTEGER
        NOT NULL
        DEFAULT 0,

      losses INTEGER
        NOT NULL
        DEFAULT 0,

      calibration_battles INTEGER
        NOT NULL
        DEFAULT 0,

      approved_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS votes (
      id BIGSERIAL PRIMARY KEY,

      user_id BIGINT
        NOT NULL
        REFERENCES users(id),

      cat_a_id BIGINT
        NOT NULL
        REFERENCES cats(id),

      cat_b_id BIGINT
        NOT NULL
        REFERENCES cats(id),

      winner_id BIGINT
        NOT NULL
        REFERENCES cats(id),

      loser_id BIGINT
        NOT NULL
        REFERENCES cats(id),

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS share_rewards (
      id BIGSERIAL PRIMARY KEY,

      user_id BIGINT
        NOT NULL
        REFERENCES users(id),

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS referrals (
      id BIGSERIAL PRIMARY KEY,

      inviter_id BIGINT
        NOT NULL
        REFERENCES users(id),

      invited_id BIGINT
        UNIQUE
        NOT NULL
        REFERENCES users(id),

      confirmed BOOLEAN
        NOT NULL
        DEFAULT FALSE,

      confirmed_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS moderation_actions (
      id BIGSERIAL PRIMARY KEY,

      moderator_id BIGINT
        NOT NULL
        REFERENCES users(id),

      target_user_id BIGINT
        REFERENCES users(id),

      cat_id BIGINT
        REFERENCES cats(id),

      action TEXT NOT NULL,

      reason TEXT,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reports (
      id BIGSERIAL PRIMARY KEY,

      reporter_id BIGINT
        NOT NULL
        REFERENCES users(id),

      cat_id BIGINT
        NOT NULL
        REFERENCES cats(id),

      reason TEXT,

      status TEXT
        NOT NULL
        DEFAULT 'OPEN'
        CHECK (
          status IN (
            'OPEN',
            'RESOLVED',
            'DISMISSED'
          )
        ),

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS
      idx_cats_status
      ON cats(status);

    CREATE INDEX IF NOT EXISTS
      idx_cats_rating
      ON cats(rating DESC);

    CREATE INDEX IF NOT EXISTS
      idx_votes_user
      ON votes(user_id);

    CREATE INDEX IF NOT EXISTS
      idx_votes_created
      ON votes(created_at);

    CREATE INDEX IF NOT EXISTS
      idx_referrals_inviter
      ON referrals(inviter_id);

    CREATE INDEX IF NOT EXISTS
      idx_share_rewards_user_created
      ON share_rewards(
        user_id,
        created_at DESC
      );
  `);

  console.log(
    "Database initialized"
  );
}

/* =========================================================
   TELEGRAM MINI APP AUTH
   ========================================================= */

function validateTelegramInitData(
  initData
) {
  if (
    !initData ||
    !TELEGRAM_BOT_TOKEN
  ) {
    return null;
  }

  try {
    const params =
      new URLSearchParams(
        initData
      );

    const receivedHash =
      params.get("hash");

    if (!receivedHash) {
      return null;
    }

    params.delete("hash");

    const dataCheckString =
      [...params.entries()]
        .sort(([a], [b]) =>
          a.localeCompare(b)
        )
        .map(
          ([key, value]) =>
            `${key}=${value}`
        )
        .join("\n");

    const secretKey =
      crypto
        .createHmac(
          "sha256",
          "WebAppData"
        )
        .update(
          TELEGRAM_BOT_TOKEN
        )
        .digest();

    const calculatedHash =
      crypto
        .createHmac(
          "sha256",
          secretKey
        )
        .update(
          dataCheckString
        )
        .digest("hex");

    const calculatedBuffer =
      Buffer.from(
        calculatedHash,
        "hex"
      );

    const receivedBuffer =
      Buffer.from(
        receivedHash,
        "hex"
      );

    if (
      calculatedBuffer.length !==
      receivedBuffer.length
    ) {
      return null;
    }

    if (
      !crypto.timingSafeEqual(
        calculatedBuffer,
        receivedBuffer
      )
    ) {
      return null;
    }

    const authDate =
      Number(
        params.get("auth_date")
      );

    if (!authDate) {
      return null;
    }

    /*
      Не принимаем очень старые
      initData.
    */
    if (
      Math.abs(
        Date.now() / 1000 -
          authDate
      ) >
      24 * 60 * 60
    ) {
      return null;
    }

    const rawUser =
      params.get("user");

    if (!rawUser) {
      return null;
    }

    const user =
      JSON.parse(rawUser);

    return {
      user,
      startParam:
        params.get(
          "start_param"
        ) || null,
    };
  } catch (error) {
    console.error(
      "Telegram validation error:",
      error
    );

    return null;
  }
}

/* =========================================================
   USERS
   ========================================================= */

async function getOrCreateUser(
  telegramUser
) {
  const normalized =
    normalizeTelegramUser(
      telegramUser
    );

  const telegramId =
    String(
      normalized.id
    );

  const shouldBeOwner =
    OWNER_TELEGRAM_ID &&
    telegramId ===
      OWNER_TELEGRAM_ID;

  let result =
    await pool.query(
      `
      SELECT *
      FROM users
      WHERE telegram_user_id = $1
      `,
      [telegramId]
    );

  if (
    result.rows.length
  ) {
    const existing =
      result.rows[0];

    const role =
      shouldBeOwner
        ? "OWNER"
        : existing.role;

    const updated =
      await pool.query(
        `
        UPDATE users
        SET
          username = $2,
          first_name = $3,
          last_name = $4,
          role = $5,
          updated_at = NOW()
        WHERE telegram_user_id = $1
        RETURNING *
        `,
        [
          telegramId,
          normalized.username,
          normalized.first_name,
          normalized.last_name,
          role,
        ]
      );

    return updated.rows[0];
  }

  const role =
    shouldBeOwner
      ? "OWNER"
      : "USER";

  const created =
    await pool.query(
      `
      INSERT INTO users (
        telegram_user_id,
        username,
        first_name,
        last_name,
        role
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5
      )
      RETURNING *
      `,
      [
        telegramId,
        normalized.username,
        normalized.first_name,
        normalized.last_name,
        role,
      ]
    );

  return created.rows[0];
}

/* =========================================================
   REFERRALS
   ========================================================= */

function parseReferralParam(
  value
) {
  if (!value) {
    return null;
  }

  const text =
    String(value);

  if (
    !text.startsWith(
      "ref_"
    )
  ) {
    return null;
  }

  const telegramId =
    text.slice(4);

  if (
    !/^\d+$/.test(
      telegramId
    )
  ) {
    return null;
  }

  return telegramId;
}

async function registerReferralIfNeeded(
  invitedUser,
  startParam
) {
  const inviterTelegramId =
    parseReferralParam(
      startParam
    );

  if (
    !inviterTelegramId
  ) {
    return;
  }

  if (
    String(
      invitedUser.telegram_user_id
    ) ===
    inviterTelegramId
  ) {
    return;
  }

  const inviter =
    await pool.query(
      `
      SELECT id
      FROM users
      WHERE telegram_user_id = $1
      LIMIT 1
      `,
      [inviterTelegramId]
    );

  if (
    !inviter.rows.length
  ) {
    return;
  }

  await pool.query(
    `
    INSERT INTO referrals (
      inviter_id,
      invited_id
    )
    VALUES ($1,$2)
    ON CONFLICT (
      invited_id
    )
    DO NOTHING
    `,
    [
      inviter.rows[0].id,
      invitedUser.id,
    ]
  );
}

async function grantReferralRewardIfNeeded(
  client,
  inviterId
) {
  const countResult =
    await client.query(
      `
      SELECT
        COUNT(*)::int AS count
      FROM referrals
      WHERE inviter_id = $1
        AND confirmed = TRUE
      `,
      [inviterId]
    );

  const count =
    Number(
      countResult.rows[0].count
    );

  if (
    count <
    REFERRALS_FOR_UNLIMITED
  ) {
    return;
  }

  /*
    Награда за 10 друзей —
    один раз.
  */
  await client.query(
    `
    UPDATE users
    SET
      unlimited_until =
        GREATEST(
          COALESCE(
            unlimited_until,
            NOW()
          ),
          NOW() +
            INTERVAL '7 days'
        ),

      referral_reward_granted_at =
        NOW(),

      updated_at =
        NOW()

    WHERE id = $1
      AND
        referral_reward_granted_at
        IS NULL
    `,
    [inviterId]
  );
}

/* =========================================================
   AUTH MIDDLEWARE
   ========================================================= */

async function auth(
  req,
  res,
  next
) {
  try {
    let telegramUser = null;
    let startParam = null;

    const initData =
      req.headers[
        "x-telegram-init-data"
      ];

    if (initData) {
      const validated =
        validateTelegramInitData(
          initData
        );

      if (validated) {
        telegramUser =
          validated.user;

        startParam =
          validated.startParam;
      }
    }

    /*
      Development mode.
      На production можно вообще
      не задавать DEV_MODE.
    */
    if (
      !telegramUser &&
      process.env.DEV_MODE ===
        "true" &&
      process.env.DEV_USER_ID
    ) {
      telegramUser = {
        id:
          process.env
            .DEV_USER_ID,

        username:
          "dev_owner",

        first_name:
          "Owner",
      };
    }

    if (!telegramUser) {
      return res
        .status(401)
        .json({
          error:
            "TELEGRAM_AUTH_REQUIRED",
        });
    }

    const user =
      await getOrCreateUser(
        telegramUser
      );

    await registerReferralIfNeeded(
      user,
      startParam
    );

    if (
      user.status ===
      "PERMANENT_BAN"
    ) {
      return res
        .status(403)
        .json({
          error:
            "PERMANENT_BAN",

          message:
            BAN_MESSAGE,
        });
    }

    req.user = user;
    req.telegramStartParam =
      startParam;

    next();
  } catch (error) {
    console.error(
      "Auth error:",
      error
    );

    res
      .status(500)
      .json({
        error:
          "AUTH_ERROR",
      });
  }
}

function requireRole(
  ...roles
) {
  return (
    req,
    res,
    next
  ) => {
    if (
      !roles.includes(
        req.user.role
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            "ACCESS_DENIED",
        });
    }

    next();
  };
}

/* =========================================================
   TELEGRAM BOT API
   ========================================================= */

async function telegramApi(
  method,
  payload = {}
) {
  if (
    !TELEGRAM_BOT_TOKEN
  ) {
    throw new Error(
      "BOT_TOKEN_NOT_SET"
    );
  }

  const response =
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify(
            payload
          ),
      }
    );

  const data =
    await response.json();

  if (!data.ok) {
    const error =
      new Error(
        `Telegram ${method}: ${
          data.description ||
          "unknown error"
        }`
      );

    error.telegramData =
      data;

    throw error;
  }

  return data.result;
}

async function sendTelegramMessage(
  chatId,
  text,
  extra = {}
) {
  if (
    !TELEGRAM_BOT_TOKEN ||
    !chatId
  ) {
    return false;
  }

  try {
    await telegramApi(
      "sendMessage",
      {
        chat_id: chatId,
        text,
        ...extra,
      }
    );

    return true;
  } catch (error) {
    console.error(
      "Telegram send error:",
      error.message
    );

    return false;
  }
}

async function notifyUserByInternalId(
  userId,
  message
) {
  try {
    const result =
      await pool.query(
        `
        SELECT telegram_user_id
        FROM users
        WHERE id = $1
        LIMIT 1
        `,
        [userId]
      );

    if (
      !result.rows.length
    ) {
      return;
    }

    await sendTelegramMessage(
      result.rows[0]
        .telegram_user_id,
      message
    );
  } catch (error) {
    console.error(
      "Notification error:",
      error
    );
  }
}

/* =========================================================
   TELEGRAM /START
   ========================================================= */

async function handleTelegramStart(
  message,
  payload
) {
  const telegramUser =
    message.from;

  if (!telegramUser) {
    return;
  }

  const user =
    await getOrCreateUser(
      telegramUser
    );

  if (payload) {
    await registerReferralIfNeeded(
      user,
      payload
    );
  }

  if (
    user.status ===
    "PERMANENT_BAN"
  ) {
    await sendTelegramMessage(
      message.chat.id,
      BAN_MESSAGE
    );

    return;
  }

  const name =
    telegramUser.first_name ||
    "человек";

  const text =
`🐈 Добро пожаловать в КОТОБОР, ${name}.

Здесь всё просто:
два кота — один выбор.

У тебя есть 5 голосов каждые 5 часов.

Загрузишь своего кота после запуска приложения — после одобрения модератором лимит станет 10 голосов каждые 5 часов.

Выбирай внимательно. Коты всё запомнят.`;

  await sendTelegramMessage(
    message.chat.id,
    text,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text:
                "⚔️ Открыть КОТОБОР",
              web_app: {
                url: APP_URL,
              },
            },
          ],
        ],
      },
    }
  );
}

async function handleTelegramUpdate(
  update
) {
  const message =
    update.message;

  if (
    !message ||
    !message.chat ||
    message.chat.type !==
      "private"
  ) {
    return;
  }

  const text =
    String(
      message.text || ""
    ).trim();

  if (
    text.startsWith(
      "/start"
    )
  ) {
    const parts =
      text.split(/\s+/);

    const payload =
      parts.length > 1
        ? parts[1]
        : null;

    await handleTelegramStart(
      message,
      payload
    );

    return;
  }

  if (
    text === "/help"
  ) {
    await sendTelegramMessage(
      message.chat.id,
      "Нажми «Открыть КОТОБОР» и выбирай лучшего кота. 🐈⚔️",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  "⚔️ Открыть КОТОБОР",
                web_app: {
                  url:
                    APP_URL,
                },
              },
            ],
          ],
        },
      }
    );
  }
}

/* =========================================================
   TELEGRAM LONG POLLING
   ========================================================= */

let telegramPollingActive =
  false;

async function startTelegramBot() {
  if (
    !TELEGRAM_BOT_TOKEN
  ) {
    console.log(
      "Telegram bot disabled: BOT_TOKEN is not set"
    );

    return;
  }

  if (
    telegramPollingActive
  ) {
    return;
  }

  telegramPollingActive =
    true;

  try {
    /*
      Long polling и webhook
      одновременно использовать нельзя.
    */
    await telegramApi(
      "deleteWebhook",
      {
        drop_pending_updates:
          false,
      }
    );

    await telegramApi(
      "setMyCommands",
      {
        commands: [
          {
            command: "start",
            description:
              "Открыть КОТОБОР",
          },
          {
            command: "help",
            description:
              "Помощь",
          },
        ],
      }
    );

    const me =
      await telegramApi(
        "getMe"
      );

    console.log(
      `Telegram bot connected: @${me.username}`
    );
  } catch (error) {
    console.error(
      "Telegram initialization error:",
      error.message
    );
  }

  let offset = 0;

  while (
    telegramPollingActive
  ) {
    try {
      const updates =
        await telegramApi(
          "getUpdates",
          {
            offset,
            timeout: 25,

            allowed_updates: [
              "message",
            ],
          }
        );

      for (
        const update
        of updates
      ) {
        offset =
          update.update_id + 1;

        try {
          await handleTelegramUpdate(
            update
          );
        } catch (error) {
          console.error(
            "Telegram update error:",
            error
          );
        }
      }
    } catch (error) {
      console.error(
        "Telegram polling error:",
        error.message
      );

      /*
        При коротком перекрытии
        Railway deployments Telegram
        может временно вернуть conflict.
      */
      await sleep(3000);
    }
  }
}

/* =========================================================
   CAT STATE
   ========================================================= */

async function hasApprovedCat(
  userId,
  db = pool
) {
  const result =
    await db.query(
      `
      SELECT 1
      FROM cats
      WHERE owner_id = $1
        AND status = 'APPROVED'
      LIMIT 1
      `,
      [userId]
    );

  return (
    result.rows.length > 0
  );
}

/* =========================================================
   TRUE ROLLING 5-HOUR VOTE LIMIT
   ========================================================= */

async function getVoteState(
  user,
  db = pool
) {
  const currentTime =
    now();

  if (
    user.unlimited_until &&
    new Date(
      user.unlimited_until
    ) > currentTime
  ) {
    return {
      unlimited: true,

      remaining: null,

      baseLimit: null,

      bonusVotes: null,

      used: null,

      resetsAt: null,

      unlimitedUntil:
        user.unlimited_until,
    };
  }

  const approvedCat =
    await hasApprovedCat(
      user.id,
      db
    );

  const baseLimit =
    approvedCat
      ? CAT_LIMIT
      : BASE_LIMIT;

  /*
    Все реальные голоса
    за последние 5 часов.
  */
  const voteResult =
    await db.query(
      `
      SELECT
        COUNT(*)::int AS count,
        MIN(created_at)
          AS oldest_vote
      FROM votes
      WHERE user_id = $1
        AND created_at >
          NOW() -
          INTERVAL '5 hours'
      `,
      [user.id]
    );

  const used =
    Number(
      voteResult.rows[0].count
    );

  /*
    Бонус за шаринг действует,
    если награда была получена
    в последние 5 часов.
  */
  const shareResult =
    await db.query(
      `
      SELECT created_at
      FROM share_rewards
      WHERE user_id = $1
        AND created_at >
          NOW() -
          INTERVAL '5 hours'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [user.id]
    );

  const hasShareBonus =
    shareResult.rows.length > 0;

  const bonusVotes =
    hasShareBonus
      ? SHARE_BONUS
      : 0;

  const totalAvailable =
    baseLimit +
    bonusVotes;

  const remaining =
    Math.max(
      0,
      totalAvailable -
        used
    );

  let resetsAt = null;

  /*
    В скользящем окне новый
    голос становится доступен,
    когда самый старый голос
    выйдет из последних 5 часов.
  */
  if (
    remaining <= 0 &&
    voteResult.rows[0]
      .oldest_vote
  ) {
    resetsAt =
      new Date(
        new Date(
          voteResult.rows[0]
            .oldest_vote
        ).getTime() +
          FIVE_HOURS_MS
      );
  }

  return {
    unlimited: false,

    baseLimit,

    bonusVotes,

    used,

    remaining,

    resetsAt,

    shareBonusActive:
      hasShareBonus,

    shareBonusAvailableAt:
      hasShareBonus
        ? new Date(
            new Date(
              shareResult.rows[0]
                .created_at
            ).getTime() +
              FIVE_HOURS_MS
          )
        : null,
  };
}

/* =========================================================
   ELO
   ========================================================= */

function expectedScore(
  ratingA,
  ratingB
) {
  return (
    1 /
    (
      1 +
      Math.pow(
        10,
        (ratingB -
          ratingA) /
          400
      )
    )
  );
}

function kFactor(cat) {
  if (
    Number(
      cat.calibration_battles
    ) < 20
  ) {
    return 64;
  }

  if (
    Number(
      cat.battles
    ) < 50
  ) {
    return 40;
  }

  return 24;
}

function calculateElo(
  winner,
  loser
) {
  const expectedWinner =
    expectedScore(
      Number(
        winner.rating
      ),
      Number(
        loser.rating
      )
    );

  const expectedLoser =
    expectedScore(
      Number(
        loser.rating
      ),
      Number(
        winner.rating
      )
    );

  const winnerNew =
    Number(
      winner.rating
    ) +
    kFactor(winner) *
      (
        1 -
        expectedWinner
      );

  const loserNew =
    Number(
      loser.rating
    ) +
    kFactor(loser) *
      (
        0 -
        expectedLoser
      );

  return {
    winnerRating:
      winnerNew,

    loserRating:
      loserNew,
  };
}

/* =========================================================
   PROFILE
   ========================================================= */

app.get(
  "/api/me",
  auth,
  async (req, res) => {
    try {
      const catResult =
        await pool.query(
          `
          SELECT *
          FROM cats
          WHERE owner_id = $1
          ORDER BY
            created_at DESC
          LIMIT 1
          `,
          [req.user.id]
        );

      const voteState =
        await getVoteState(
          req.user
        );

      const referrals =
        await pool.query(
          `
          SELECT
            COUNT(*)::int
              AS count
          FROM referrals
          WHERE inviter_id = $1
            AND confirmed = TRUE
          `,
          [req.user.id]
        );

      res.json({
        user:
          safeUser(
            req.user
          ),

        cat:
          catResult.rows[0] ||
          null,

        votes:
          voteState,

        referrals: {
          confirmed:
            Number(
              referrals
                .rows[0]
                .count
            ),

          target:
            REFERRALS_FOR_UNLIMITED,
        },
      });
    } catch (error) {
      console.error(
        "Profile error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "PROFILE_ERROR",
        });
    }
  }
);

/* =========================================================
   SHARE BONUS
   ========================================================= */

app.post(
  "/api/share-reward",
  auth,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      /*
        Блокируем пользователя,
        чтобы двойной быстрый tap
        не дал два бонуса.
      */
      await client.query(
        `
        SELECT id
        FROM users
        WHERE id = $1
        FOR UPDATE
        `,
        [req.user.id]
      );

      const previous =
        await client.query(
          `
          SELECT created_at
          FROM share_rewards
          WHERE user_id = $1
          ORDER BY
            created_at DESC
          LIMIT 1
          `,
          [req.user.id]
        );

      if (
        previous.rows.length
      ) {
        const last =
          new Date(
            previous
              .rows[0]
              .created_at
          );

        if (
          now() - last <
          FIVE_HOURS_MS
        ) {
          await client.query(
            "ROLLBACK"
          );

          return res
            .status(409)
            .json({
              error:
                "SHARE_COOLDOWN",

              availableAt:
                new Date(
                  last.getTime() +
                    FIVE_HOURS_MS
                ),
            });
        }
      }

      await client.query(
        `
        INSERT INTO
          share_rewards (
            user_id
          )
        VALUES ($1)
        `,
        [req.user.id]
      );

      await client.query(
        "COMMIT"
      );

      const votes =
        await getVoteState(
          req.user
        );

      res.json({
        success: true,
        bonus:
          SHARE_BONUS,
        votes,
      });
    } catch (error) {
      await client
        .query(
          "ROLLBACK"
        )
        .catch(() => {});

      console.error(
        "Share error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "SHARE_ERROR",
        });
    } finally {
      client.release();
    }
  }
);

/* =========================================================
   PAIR GENERATION
   ========================================================= */

function pairKey(a, b) {
  const x =
    Number(a);

  const y =
    Number(b);

  return x < y
    ? `${x}:${y}`
    : `${y}:${x}`;
}

function randomItem(array) {
  if (
    !array.length
  ) {
    return null;
  }

  return array[
    Math.floor(
      Math.random() *
        array.length
    )
  ];
}

async function selectBattlePair(
  userId
) {
  const candidatesResult =
    await pool.query(
      `
      SELECT *
      FROM cats
      WHERE status =
        'APPROVED'

        AND owner_id <> $1

      ORDER BY
        random()

      LIMIT 120
      `,
      [userId]
    );

  const candidates =
    candidatesResult.rows;

  if (
    candidates.length < 2
  ) {
    return null;
  }

  const previousPairsResult =
    await pool.query(
      `
      SELECT
        cat_a_id,
        cat_b_id
      FROM votes
      WHERE user_id = $1
      `,
      [userId]
    );

  const previousPairs =
    new Set(
      previousPairsResult.rows.map(
        (row) =>
          pairKey(
            row.cat_a_id,
            row.cat_b_id
          )
      )
    );

  function isAllowedPair(
    a,
    b
  ) {
    if (
      !a ||
      !b ||
      String(a.id) ===
        String(b.id)
    ) {
      return false;
    }

    return !previousPairs.has(
      pairKey(
        a.id,
        b.id
      )
    );
  }

  /*
    Пытаемся сформировать
    пару по нужному режиму
    до 100 раз.
  */
  for (
    let attempt = 0;
    attempt < 100;
    attempt++
  ) {
    const mode =
      Math.random();

    let first = null;
    let second = null;

    /*
      ~30%:
      новый / мало оценённый кот.
    */
    if (
      mode < 0.30
    ) {
      const calibration =
        candidates.filter(
          (cat) =>
            Number(
              cat.calibration_battles
            ) < 20
        );

      first =
        randomItem(
          calibration
        ) ||
        randomItem(
          candidates
        );

      const others =
        candidates.filter(
          (cat) =>
            String(
              cat.id
            ) !==
            String(
              first.id
            )
        );

      /*
        Оппонент желательно
        близкий по рейтингу.
      */
      others.sort(
        (a, b) =>
          Math.abs(
            Number(a.rating) -
              Number(
                first.rating
              )
          ) -
          Math.abs(
            Number(b.rating) -
              Number(
                first.rating
              )
          )
      );

      second =
        randomItem(
          others.slice(
            0,
            Math.min(
              10,
              others.length
            )
          )
        );
    }

    /*
      ~50%:
      близкий рейтинг.
    */
    else if (
      mode < 0.80
    ) {
      first =
        randomItem(
          candidates
        );

      const others =
        candidates
          .filter(
            (cat) =>
              String(
                cat.id
              ) !==
              String(
                first.id
              )
          )
          .sort(
            (a, b) =>
              Math.abs(
                Number(
                  a.rating
                ) -
                  Number(
                    first.rating
                  )
              ) -
              Math.abs(
                Number(
                  b.rating
                ) -
                  Number(
                    first.rating
                  )
              )
          );

      second =
        randomItem(
          others.slice(
            0,
            Math.min(
              12,
              others.length
            )
          )
        );
    }

    /*
      ~20%:
      контрольная случайная пара.
    */
    else {
      first =
        randomItem(
          candidates
        );

      second =
        randomItem(
          candidates.filter(
            (cat) =>
              String(
                cat.id
              ) !==
              String(
                first.id
              )
          )
        );
    }

    if (
      isAllowedPair(
        first,
        second
      )
    ) {
      return [
        first,
        second,
      ];
    }
  }

  /*
    Fallback:
    ищем любую ещё
    не голосованную пару.
  */
  for (
    let i = 0;
    i <
    candidates.length;
    i++
  ) {
    for (
      let j = i + 1;
      j <
      candidates.length;
      j++
    ) {
      if (
        isAllowedPair(
          candidates[i],
          candidates[j]
        )
      ) {
        return [
          candidates[i],
          candidates[j],
        ];
      }
    }
  }

  return null;
}

/* =========================================================
   BATTLE
   ========================================================= */

app.get(
  "/api/battle",
  auth,
  async (req, res) => {
    try {
      const voteState =
        await getVoteState(
          req.user
        );

      if (
        !voteState.unlimited &&
        voteState.remaining <= 0
      ) {
        return res
          .status(429)
          .json({
            error:
              "VOTE_LIMIT",

            votes:
              voteState,
          });
      }

      const pair =
        await selectBattlePair(
          req.user.id
        );

      if (!pair) {
        return res
          .status(404)
          .json({
            error:
              "NO_BATTLE_AVAILABLE",
          });
      }

      res.json({
        cats: pair.map(
          (cat) => ({
            id: cat.id,
            name: cat.name,
            imageUrl:
              cat.image_url,
          })
        ),

        votes:
          voteState,
      });
    } catch (error) {
      console.error(
        "Battle error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "BATTLE_ERROR",
        });
    }
  }
);

/* =========================================================
   VOTE
   ========================================================= */

app.post(
  "/api/vote",
  auth,
  async (req, res) => {
    const client =
      await pool.connect();

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
        String(catAId) ===
          String(catBId) ||
        ![
          String(catAId),
          String(catBId),
        ].includes(
          String(winnerId)
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "INVALID_VOTE",
          });
      }

      await client.query(
        "BEGIN"
      );

      /*
        Блокируем голосование
        одного пользователя,
        чтобы лимит нельзя было
        обойти параллельными taps.
      */
      await client.query(
        `
        SELECT
          pg_advisory_xact_lock(
            $1::integer
          )
        `,
        [
          Number(
            req.user.id
          ) %
            2147483647,
        ]
      );

      const freshUserResult =
        await client.query(
          `
          SELECT *
          FROM users
          WHERE id = $1
          FOR UPDATE
          `,
          [req.user.id]
        );

      const freshUser =
        freshUserResult
          .rows[0];

      const voteStateBefore =
        await getVoteState(
          freshUser,
          client
        );

      if (
        !voteStateBefore.unlimited &&
        voteStateBefore.remaining <=
          0
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(429)
          .json({
            error:
              "VOTE_LIMIT",

            votes:
              voteStateBefore,
          });
      }

      const catsResult =
        await client.query(
          `
          SELECT *
          FROM cats
          WHERE id =
            ANY(
              $1::bigint[]
            )

            AND status =
              'APPROVED'

          FOR UPDATE
          `,
          [
            [
              catAId,
              catBId,
            ],
          ]
        );

      if (
        catsResult.rows.length !==
        2
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(404)
          .json({
            error:
              "CATS_NOT_FOUND",
          });
      }

      if (
        catsResult.rows.some(
          (cat) =>
            String(
              cat.owner_id
            ) ===
            String(
              req.user.id
            )
        )
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(403)
          .json({
            error:
              "OWN_CAT_VOTE",
          });
      }

      /*
        Именно та же ПАРА,
        а не любой встречавшийся кот.
      */
      const previousVote =
        await client.query(
          `
          SELECT 1
          FROM votes
          WHERE user_id = $1
            AND (
              (
                cat_a_id = $2
                AND
                cat_b_id = $3
              )
              OR
              (
                cat_a_id = $3
                AND
                cat_b_id = $2
              )
            )
          LIMIT 1
          `,
          [
            req.user.id,
            catAId,
            catBId,
          ]
        );

      if (
        previousVote.rows.length
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(409)
          .json({
            error:
              "PAIR_ALREADY_VOTED",
          });
      }

      const winner =
        catsResult.rows.find(
          (cat) =>
            String(
              cat.id
            ) ===
            String(
              winnerId
            )
        );

      const loser =
        catsResult.rows.find(
          (cat) =>
            String(
              cat.id
            ) !==
            String(
              winnerId
            )
        );

      const elo =
        calculateElo(
          winner,
          loser
        );

      await client.query(
        `
        INSERT INTO votes (
          user_id,
          cat_a_id,
          cat_b_id,
          winner_id,
          loser_id
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5
        )
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

          battles =
            battles + 1,

          wins =
            wins + 1,

          calibration_battles =
            LEAST(
              calibration_battles
                + 1,
              20
            ),

          updated_at =
            NOW()

        WHERE id = $1
        `,
        [
          winner.id,
          elo.winnerRating,
        ]
      );

      await client.query(
        `
        UPDATE cats
        SET
          rating = $2,

          battles =
            battles + 1,

          losses =
            losses + 1,

          calibration_battles =
            LEAST(
              calibration_battles
                + 1,
              20
            ),

          updated_at =
            NOW()

        WHERE id = $1
        `,
        [
          loser.id,
          elo.loserRating,
        ]
      );

      /*
        Реферал считается
        подтверждённым только
        после первого настоящего
        голосования.
      */
      const referral =
        await client.query(
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

      if (
        referral.rows.length
      ) {
        await grantReferralRewardIfNeeded(
          client,
          referral
            .rows[0]
            .inviter_id
        );
      }

      await client.query(
        "COMMIT"
      );

      const refreshedUser =
        (
          await pool.query(
            `
            SELECT *
            FROM users
            WHERE id = $1
            `,
            [req.user.id]
          )
        ).rows[0];

      const voteStateAfter =
        await getVoteState(
          refreshedUser
        );

      res.json({
        success: true,

        votes:
          voteStateAfter,
      });
    } catch (error) {
      await client
        .query(
          "ROLLBACK"
        )
        .catch(() => {});

      console.error(
        "Vote error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "VOTE_ERROR",
        });
    } finally {
      client.release();
    }
  }
);

/* =========================================================
   CAT CREATE
   Пока принимает imageUrl.
   Реальную загрузку файла подключаем
   следующим отдельным шагом.
   ========================================================= */

app.post(
  "/api/cats",
  auth,
  async (req, res) => {
    try {
      const name =
        String(
          req.body.name || ""
        ).trim();

      const imageUrl =
        String(
          req.body.imageUrl ||
            ""
        ).trim();

      if (
        name.length < 1 ||
        name.length > 40
      ) {
        return res
          .status(400)
          .json({
            error:
              "INVALID_CAT_NAME",
          });
      }

      if (!imageUrl) {
        return res
          .status(400)
          .json({
            error:
              "IMAGE_REQUIRED",
          });
      }

      const existing =
        await pool.query(
          `
          SELECT 1
          FROM cats
          WHERE owner_id = $1
            AND status IN (
              'PENDING',
              'APPROVED'
            )
          LIMIT 1
          `,
          [req.user.id]
        );

      if (
        existing.rows.length
      ) {
        return res
          .status(409)
          .json({
            error:
              "CAT_ALREADY_EXISTS",
          });
      }

      const result =
        await pool.query(
          `
          INSERT INTO cats (
            owner_id,
            name,
            image_url
          )
          VALUES (
            $1,
            $2,
            $3
          )
          RETURNING *
          `,
          [
            req.user.id,
            name,
            imageUrl,
          ]
        );

      res
        .status(201)
        .json({
          success: true,

          cat:
            result.rows[0],
        });
    } catch (error) {
      console.error(
        "Cat create error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "CAT_CREATE_ERROR",
        });
    }
  }
);

/* =========================================================
   RANKING
   ========================================================= */

app.get(
  "/api/ranking",
  auth,
  async (req, res) => {
    try {
      const top =
        await pool.query(
          `
          SELECT
            id,
            owner_id,
            name,
            image_url,
            rating,
            battles,
            wins,
            losses,

            RANK()
              OVER (
                ORDER BY
                  rating DESC
              )
              AS position

          FROM cats

          WHERE status =
            'APPROVED'

            AND
              calibration_battles
              >= 20

          ORDER BY
            rating DESC

          LIMIT 100
          `
        );

      res.json({
        ranking:
          top.rows.map(
            (cat) => ({
              ...cat,

              winRate:
                Number(
                  cat.battles
                ) > 0
                  ? Math.round(
                      (
                        Number(
                          cat.wins
                        ) /
                        Number(
                          cat.battles
                        )
                      ) *
                        1000
                    ) /
                    10
                  : 0,
            })
          ),
      });
    } catch (error) {
      console.error(
        "Ranking error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "RANKING_ERROR",
        });
    }
  }
);

app.get(
  "/api/my-cat-ranking",
  auth,
  async (req, res) => {
    try {
      const catResult =
        await pool.query(
          `
          SELECT *
          FROM cats
          WHERE owner_id = $1
          ORDER BY
            created_at DESC
          LIMIT 1
          `,
          [req.user.id]
        );

      if (
        !catResult.rows.length
      ) {
        return res.json({
          calibrated: false,
          reason:
            "NO_CAT",
        });
      }

      const ownCat =
        catResult.rows[0];

      if (
        ownCat.status !==
          "APPROVED" ||
        Number(
          ownCat
            .calibration_battles
        ) < 20
      ) {
        return res.json({
          calibrated: false,

          calibrationBattles:
            Number(
              ownCat
                .calibration_battles
            ),

          target: 20,
        });
      }

      const mine =
        await pool.query(
          `
          WITH ranked AS (
            SELECT
              c.*,

              RANK()
                OVER (
                  ORDER BY
                    rating DESC
                )
                AS position,

              COUNT(*)
                OVER ()
                AS total

            FROM cats c

            WHERE
              c.status =
                'APPROVED'

              AND
                c.calibration_battles
                >= 20
          )

          SELECT *
          FROM ranked
          WHERE id = $1
          LIMIT 1
          `,
          [ownCat.id]
        );

      if (
        !mine.rows.length
      ) {
        return res.json({
          calibrated: false,
        });
      }

      const cat =
        mine.rows[0];

      const position =
        Number(
          cat.position
        );

      const total =
        Number(
          cat.total
        );

      const around =
        await pool.query(
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

              RANK()
                OVER (
                  ORDER BY
                    rating DESC
                )
                AS position

            FROM cats

            WHERE
              status =
                'APPROVED'

              AND
                calibration_battles
                >= 20
          )

          SELECT *
          FROM ranked

          WHERE position
            BETWEEN $1
            AND $2

          ORDER BY
            position
          `,
          [
            Math.max(
              1,
              position - 10
            ),

            position + 10,
          ]
        );

      const percentile =
        total <= 1
          ? 100
          : Math.max(
              0,
              Math.min(
                100,
                (
                  (
                    total -
                    position
                  ) /
                  (
                    total -
                    1
                  )
                ) *
                  100
              )
            );

      res.json({
        calibrated: true,

        position,

        total,

        percentile:
          Math.round(
            percentile * 10
          ) / 10,

        around:
          around.rows,
      });
    } catch (error) {
      console.error(
        "My ranking error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "MY_RANKING_ERROR",
        });
    }
  }
);

/* =========================================================
   REPORTS
   ========================================================= */

app.post(
  "/api/reports",
  auth,
  async (req, res) => {
    try {
      const {
        catId,
        reason,
      } = req.body;

      const cat =
        await pool.query(
          `
          SELECT id
          FROM cats
          WHERE id = $1
            AND status =
              'APPROVED'
          LIMIT 1
          `,
          [catId]
        );

      if (
        !cat.rows.length
      ) {
        return res
          .status(404)
          .json({
            error:
              "CAT_NOT_FOUND",
          });
      }

      const result =
        await pool.query(
          `
          INSERT INTO reports (
            reporter_id,
            cat_id,
            reason
          )
          VALUES (
            $1,
            $2,
            $3
          )
          RETURNING *
          `,
          [
            req.user.id,
            catId,
            String(
              reason || ""
            ).slice(
              0,
              500
            ),
          ]
        );

      res
        .status(201)
        .json({
          success: true,
          report:
            result.rows[0],
        });
    } catch (error) {
      console.error(
        "Report error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "REPORT_ERROR",
        });
    }
  }
);

/* =========================================================
   MODERATION - PENDING
   ========================================================= */

app.get(
  "/api/admin/pending",
  auth,
  requireRole(
    "MODERATOR",
    "OWNER"
  ),
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT
            c.*,

            u.telegram_user_id,
            u.username,
            u.first_name,
            u.last_name

          FROM cats c

          JOIN users u
            ON u.id =
              c.owner_id

          WHERE c.status =
            'PENDING'

          ORDER BY
            c.created_at ASC
          `
        );

      res.json({
        cats:
          result.rows,
      });
    } catch (error) {
      console.error(
        "Pending error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "PENDING_ERROR",
        });
    }
  }
);

/* =========================================================
   MODERATION - APPROVE
   ========================================================= */

app.post(
  "/api/admin/cats/:id/approve",
  auth,
  requireRole(
    "MODERATOR",
    "OWNER"
  ),
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          UPDATE cats
          SET
            status =
              'APPROVED',

            approved_at =
              NOW(),

            updated_at =
              NOW()

          WHERE id = $1
            AND status =
              'PENDING'

          RETURNING *
          `,
          [req.params.id]
        );

      if (
        !result.rows.length
      ) {
        return res
          .status(404)
          .json({
            error:
              "PENDING_CAT_NOT_FOUND",
          });
      }

      const cat =
        result.rows[0];

      await pool.query(
        `
        INSERT INTO
          moderation_actions (
            moderator_id,
            cat_id,
            target_user_id,
            action
          )
        VALUES (
          $1,
          $2,
          $3,
          'APPROVE'
        )
        `,
        [
          req.user.id,
          cat.id,
          cat.owner_id,
        ]
      );

      await notifyUserByInternalId(
        cat.owner_id,
        `✅ ${cat.name} прошёл модерацию!

Теперь он участвует в КОТОБОРЕ.

Ваш лимит также увеличен до 10 голосов каждые 5 часов. 🐈⚔️`
      );

      res.json({
        success: true,
      });
    } catch (error) {
      console.error(
        "Approve error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "APPROVE_ERROR",
        });
    }
  }
);

/* =========================================================
   MODERATION - REJECT
   ========================================================= */

app.post(
  "/api/admin/cats/:id/reject",
  auth,
  requireRole(
    "MODERATOR",
    "OWNER"
  ),
  async (req, res) => {
    try {
      const reason =
        String(
          req.body.reason ||
            "Другое"
        ).slice(
          0,
          500
        );

      const result =
        await pool.query(
          `
          UPDATE cats
          SET
            status =
              'REJECTED',

            updated_at =
              NOW()

          WHERE id = $1
            AND status =
              'PENDING'

          RETURNING *
          `,
          [req.params.id]
        );

      if (
        !result.rows.length
      ) {
        return res
          .status(404)
          .json({
            error:
              "PENDING_CAT_NOT_FOUND",
          });
      }

      const cat =
        result.rows[0];

      await pool.query(
        `
        INSERT INTO
          moderation_actions (
            moderator_id,
            cat_id,
            target_user_id,
            action,
            reason
          )
        VALUES (
          $1,
          $2,
          $3,
          'REJECT',
          $4
        )
        `,
        [
          req.user.id,
          cat.id,
          cat.owner_id,
          reason,
        ]
      );

      await notifyUserByInternalId(
        cat.owner_id,
        `😿 Фото ${cat.name} не прошло модерацию.

Причина: ${reason}

Можно будет загрузить другое фото.`
      );

      res.json({
        success: true,
      });
    } catch (error) {
      console.error(
        "Reject error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "REJECT_ERROR",
        });
    }
  }
);

/* =========================================================
   PERMANENT BAN
   ========================================================= */

app.post(
  "/api/admin/users/:id/permanent-ban",
  auth,
  requireRole(
    "MODERATOR",
    "OWNER"
  ),
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const reason =
        String(
          req.body.reason ||
            ""
        )
          .trim()
          .slice(
            0,
            500
          );

      if (!reason) {
        return res
          .status(400)
          .json({
            error:
              "BAN_REASON_REQUIRED",
          });
      }

      if (
        String(
          req.params.id
        ) ===
        String(
          req.user.id
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "CANNOT_BAN_SELF",
          });
      }

      await client.query(
        "BEGIN"
      );

      const target =
        await client.query(
          `
          SELECT *
          FROM users
          WHERE id = $1
          FOR UPDATE
          `,
          [req.params.id]
        );

      if (
        !target.rows.length
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(404)
          .json({
            error:
              "USER_NOT_FOUND",
          });
      }

      /*
        OWNER не может быть
        заблокирован модератором.
      */
      if (
        target.rows[0].role ===
        "OWNER"
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(403)
          .json({
            error:
              "CANNOT_BAN_OWNER",
          });
      }

      await client.query(
        `
        UPDATE users
        SET
          status =
            'PERMANENT_BAN',

          updated_at =
            NOW()

        WHERE id = $1
        `,
        [req.params.id]
      );

      await client.query(
        `
        UPDATE cats
        SET
          status =
            'HIDDEN',

          updated_at =
            NOW()

        WHERE owner_id = $1

          AND status IN (
            'PENDING',
            'APPROVED'
          )
        `,
        [req.params.id]
      );

      await client.query(
        `
        INSERT INTO
          moderation_actions (
            moderator_id,
            target_user_id,
            action,
            reason
          )
        VALUES (
          $1,
          $2,
          'PERMANENT_BAN',
          $3
        )
        `,
        [
          req.user.id,
          req.params.id,
          reason,
        ]
      );

      await client.query(
        "COMMIT"
      );

      await sendTelegramMessage(
        target.rows[0]
          .telegram_user_id,
        BAN_MESSAGE
      );

      res.json({
        success: true,

        message:
          BAN_MESSAGE,
      });
    } catch (error) {
      await client
        .query(
          "ROLLBACK"
        )
        .catch(() => {});

      console.error(
        "Ban error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "BAN_ERROR",
        });
    } finally {
      client.release();
    }
  }
);

/* =========================================================
   ADMIN REPORTS
   ========================================================= */

app.get(
  "/api/admin/reports",
  auth,
  requireRole(
    "MODERATOR",
    "OWNER"
  ),
  async (req, res) => {
    try {
      const reports =
        await pool.query(
          `
          SELECT
            r.*,

            c.name
              AS cat_name,

            c.image_url,

            u.telegram_user_id
              AS reporter_telegram_id,

            u.username
              AS reporter_username

          FROM reports r

          JOIN cats c
            ON c.id =
              r.cat_id

          JOIN users u
            ON u.id =
              r.reporter_id

          WHERE r.status =
            'OPEN'

          ORDER BY
            r.created_at ASC
          `
        );

      res.json({
        reports:
          reports.rows,
      });
    } catch (error) {
      console.error(
        "Reports queue error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "REPORTS_QUEUE_ERROR",
        });
    }
  }
);

/* =========================================================
   OWNER - USERS
   ========================================================= */

app.get(
  "/api/owner/users",
  auth,
  requireRole(
    "OWNER"
  ),
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT
            id,
            telegram_user_id,
            username,
            first_name,
            last_name,
            role,
            status,
            created_at

          FROM users

          ORDER BY
            created_at DESC

          LIMIT 500
          `
        );

      res.json({
        users:
          result.rows,
      });
    } catch (error) {
      console.error(
        "Owner users error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "OWNER_USERS_ERROR",
        });
    }
  }
);

app.post(
  "/api/owner/users/:id/role",
  auth,
  requireRole(
    "OWNER"
  ),
  async (req, res) => {
    try {
      const role =
        req.body.role;

      if (
        ![
          "USER",
          "MODERATOR",
        ].includes(role)
      ) {
        return res
          .status(400)
          .json({
            error:
              "INVALID_ROLE",
          });
      }

      const result =
        await pool.query(
          `
          UPDATE users
          SET
            role = $2,
            updated_at =
              NOW()

          WHERE id = $1
            AND role <>
              'OWNER'

          RETURNING
            id,
            role
          `,
          [
            req.params.id,
            role,
          ]
        );

      if (
        !result.rows.length
      ) {
        return res
          .status(404)
          .json({
            error:
              "USER_NOT_FOUND_OR_OWNER",
          });
      }

      res.json({
        success: true,

        user:
          result.rows[0],
      });
    } catch (error) {
      console.error(
        "Role update error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "ROLE_UPDATE_ERROR",
        });
    }
  }
);

/* =========================================================
   OWNER - UNBAN
   ========================================================= */

app.post(
  "/api/owner/users/:id/unban",
  auth,
  requireRole(
    "OWNER"
  ),
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          UPDATE users
          SET
            status =
              'ACTIVE',

            updated_at =
              NOW()

          WHERE id = $1
            AND role <>
              'OWNER'

          RETURNING *
          `,
          [req.params.id]
        );

      if (
        !result.rows.length
      ) {
        return res
          .status(404)
          .json({
            error:
              "USER_NOT_FOUND",
          });
      }

      await pool.query(
        `
        INSERT INTO
          moderation_actions (
            moderator_id,
            target_user_id,
            action
          )
        VALUES (
          $1,
          $2,
          'UNBAN'
        )
        `,
        [
          req.user.id,
          req.params.id,
        ]
      );

      await sendTelegramMessage(
        result.rows[0]
          .telegram_user_id,
        `✅ Блокировка в КОТОБОРЕ снята владельцем сервиса.`
      );

      res.json({
        success: true,
      });
    } catch (error) {
      console.error(
        "Unban error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "UNBAN_ERROR",
        });
    }
  }
);

/* =========================================================
   OWNER - MODERATION LOG
   ========================================================= */

app.get(
  "/api/owner/moderation-log",
  auth,
  requireRole(
    "OWNER"
  ),
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT
            m.*,

            moderator.username
              AS moderator_username,

            target.username
              AS target_username,

            target.telegram_user_id
              AS target_telegram_id

          FROM
            moderation_actions m

          LEFT JOIN users
            moderator
            ON moderator.id =
              m.moderator_id

          LEFT JOIN users
            target
            ON target.id =
              m.target_user_id

          ORDER BY
            m.created_at DESC

          LIMIT 1000
          `
        );

      res.json({
        actions:
          result.rows,
      });
    } catch (error) {
      console.error(
        "Moderation log error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "MODERATION_LOG_ERROR",
        });
    }
  }
);

/* =========================================================
   HEALTH
   ========================================================= */

app.get(
  "/api/health",
  async (req, res) => {
    try {
      await pool.query(
        "SELECT 1"
      );

      res.json({
        ok: true,

        app:
          "КОТОБОР",

        database: true,

        telegramBot:
          Boolean(
            TELEGRAM_BOT_TOKEN
          ),

        appUrl:
          APP_URL,
      });
    } catch (error) {
      res
        .status(500)
        .json({
          ok: false,

          database: false,

          telegramBot:
            Boolean(
              TELEGRAM_BOT_TOKEN
            ),
        });
    }
  }
);

/* =========================================================
   FRONTEND FALLBACK
   ========================================================= */

app.get(
  "*",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

/* =========================================================
   START
   ========================================================= */

async function start() {
  try {
    await initDatabase();

    /*
      Если владелец уже присутствует
      в базе — синхронизируем роль
      сразу при старте.
      Если ещё нет — роль OWNER
      будет установлена автоматически
      при первом входе.
    */
    if (
      OWNER_TELEGRAM_ID
    ) {
      await pool.query(
        `
        UPDATE users
        SET
          role =
            'OWNER',

          updated_at =
            NOW()

        WHERE telegram_user_id =
          $1
        `,
        [
          OWNER_TELEGRAM_ID,
        ]
      );
    }

    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `КОТОБОР запущен на порту ${PORT}`
        );

        /*
          Не await:
          HTTP сервер должен
          продолжать работать
          независимо от Telegram.
        */
        startTelegramBot()
          .catch(
            (error) => {
              console.error(
                "Telegram fatal error:",
                error
              );
            }
          );
      }
    );
  } catch (error) {
    console.error(
      "Startup error:",
      error
    );

    process.exit(1);
  }
}

start();
