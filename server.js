
[352 lines collapsed]

      border-radius: 23px 23px 0 0;
    }
    .cats-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 14px;
    }
    .cat-thumb {
      padding: 0;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: var(--card);
      color: white;
      text-align: left;
    }
    .cat-thumb img {
      width: 100%;
      aspect-ratio: 1 / 1;
      display: block;
      object-fit: cover;
    }
    .cat-thumb-body {
      padding: 10px 11px 12px;
    }
    .cat-thumb-name {
      font-size: 15px;
      font-weight: 900;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .cat-thumb-status {
      margin-top: 5px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
    }
    .admin-tabs {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 14px;
    }
    .admin-tab {
      padding: 12px 10px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(255,255,255,.04);
      color: var(--muted);
      font-weight: 900;
    }
    .admin-tab.active {
      color: white;
      background: rgba(255,101,53,.18);
      border-color: rgba(255,101,53,.45);
    }
    .admin-panel {
      display: none;
    }
    .admin-panel.active {
      display: block;
    }
    .admin-user {
      padding: 14px;
      margin-bottom: 10px;
    }
    .admin-user-name {
      font-size: 16px;
      font-weight: 900;
    }
    .admin-user-meta {
      margin-top: 5px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .my-cat-info {
      padding: 17px;
    }

[426 lines collapsed]

      <section id="page-mycat" class="page">
        <div class="section-title">
          Мой кот
          Мои коты
        </div>
        <div id="myCatContainer"></div>

[58 lines collapsed]

      <section id="page-admin" class="page">
        <div class="section-title">
          Модерация
          Админ
        </div>
        <div class="section-subtitle">
          Здесь появляются новые фотографии до выхода в битвы.
        </div>
        <div class="admin-tabs">
          <button
            id="adminTabModeration"
            class="admin-tab active"
            type="button"
            data-admin-tab="moderation"
          >
            Модерация
          </button>
        <div class="admin-toolbar">
          <div id="adminCount" class="admin-count">
            Загрузка…
          </div>
          <button
            id="adminRefresh"
            class="btn admin-refresh"
            id="adminTabUsers"
            class="admin-tab"
            type="button"
            data-admin-tab="users"
          >
            ↻ Обновить
            Пользователи
          </button>
        </div>
        <div
          id="adminPanelModeration"
          class="admin-panel active"
        >
          <div class="section-subtitle">
            Здесь появляются новые фотографии до выхода в битвы.
          </div>
          <div class="admin-toolbar">
            <div id="adminCount" class="admin-count">
              Загрузка…
            </div>
            <button
              id="adminRefresh"
              class="btn admin-refresh"
              type="button"
            >
              ↻ Обновить
            </button>
          </div>
          <div id="adminQueue">
            <div class="loading">
              Загружаем очередь…
            </div>
          </div>
