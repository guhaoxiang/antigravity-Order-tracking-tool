# GitHub 版本控制指南

每次將新專案推送到 GitHub 進行版本控制時，依照此指南操作。

---

## 一、推送前需要準備的資料

| 項目 | 說明 | 範例 |
|------|------|------|
| **GitHub 帳號** | 你的 GitHub 使用者名稱 | `guhaoxiang` |
| **Repository 名稱** | GitHub 上的 repo 名稱 | `antigravity-Order-tracking-tool` |
| **Repo 可見性** | public 或 private | `private` |
| **分支名稱** | 主要分支名稱 | `main` |

---

## 二、安全檢查清單（推送前必做）

### 1. 確認 .gitignore 存在且包含以下項目

```
node_modules/
.env
.env.local
.env.*.local
*.log
```

### 2. 確認沒有 secrets 會被推送

執行以下指令檢查即將推送的檔案中是否含有敏感資訊：

```bash
# 列出所有將被 git 追蹤的檔案
git ls-files --cached --others --exclude-standard

# 搜尋可能的 secrets
git diff --cached | grep -iE "(password|secret|token|key|xoxb-|sb_secret)" || echo "安全 ✓"
```

### 3. 確認 .env.example 存在

`.env.example` 應包含所有環境變數的 key（但不含實際值），供其他人參考。

---

## 三、首次推送步驟

### 步驟 1：初始化 Git（如果尚未初始化）

```bash
git init
git branch -M main
```

### 步驟 2：在 GitHub 建立 Repository

```bash
# 使用 gh CLI（推薦）
gh repo create <REPO_NAME> --private --source=. --remote=origin

# 或手動在 https://github.com/new 建立後
git remote add origin https://github.com/<USERNAME>/<REPO_NAME>.git
```

### 步驟 3：處理 Git Submodule（如果有）

如果專案中有引用其他 Git repository（如 zemo-api）：

```bash
# 檢查是否有 submodule
git ls-files --stage | grep "^160000"

# 如果有，且 .gitmodules 不存在，需建立
# 先移除舊的 git 追蹤
git rm --cached <submodule-path>

# 重新加入為 submodule
git submodule add <remote-url> <submodule-path>
```

### 步驟 4：提交並推送

```bash
git add .
git status  # 確認沒有 .env 或 secrets
git commit -m "Initial commit"
git push -u origin main
```

---

## 四、日常工作流程

### 修改程式碼後提交

```bash
git add <修改的檔案>
git commit -m "描述這次修改的內容"
git push
```

### 常用 Git 指令

| 指令 | 用途 |
|------|------|
| `git status` | 查看目前修改狀態 |
| `git diff` | 查看未暫存的修改內容 |
| `git log --oneline -10` | 查看最近 10 筆 commit |
| `git pull` | 拉取遠端最新程式碼 |
| `git stash` | 暫存目前修改 |
| `git stash pop` | 恢復暫存的修改 |

---

## 五、設定 Repository 為 Private

```bash
# 使用 gh CLI
gh repo edit <USERNAME>/<REPO_NAME> --visibility private

# 或在 GitHub 網頁
# Settings → Danger Zone → Change repository visibility
```

---

## 六、清理已存在的 Repository 內容

如果 repo 中已有舊資料需要清除：

```bash
# 方法 1：保留 git 歷史，刪除所有檔案後重新推送
git rm -r --cached .
git add .
git commit -m "Clean up and restructure"
git push --force

# 方法 2：完全重置（刪除所有歷史）
# ⚠ 危險操作，會丟失所有 commit 歷史
rm -rf .git
git init
git branch -M main
git remote add origin https://github.com/<USERNAME>/<REPO_NAME>.git
git add .
git commit -m "Initial commit"
git push --force origin main
```

---

## 七、常見問題

### Q: push 被拒絕？
```bash
# 如果遠端有你本地沒有的 commit
git pull --rebase origin main
git push
```

### Q: 不小心 commit 了 .env？
```bash
# 從 git 追蹤中移除（但保留本地檔案）
git rm --cached .env
git commit -m "Remove .env from tracking"
git push

# ⚠ 重要：如果 secrets 已推送到 GitHub，立即更換所有洩露的 key！
```

### Q: 想取消最後一次 commit？
```bash
# 取消 commit 但保留修改
git reset --soft HEAD~1
```
