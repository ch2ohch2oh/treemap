---
description: how to implement a feature request
---

1. Create a feature branch from `main` using a short, descriptive name:

   ```
   git checkout main
   git pull
   git checkout -b feature/<short-description>
   ```

2. Implement the feature. Commit your changes incrementally with clear messages:

   ```
   git add -A
   git commit -m "feat: <description of what was done>"
   ```

3. When the feature is complete and verified, merge back into `main`:
   ```
   git checkout main
   git merge --no-ff feature/<short-description> -m "merge: <short-description>"
   git branch -d feature/<short-description>
   ```
