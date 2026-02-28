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

3. When the feature is complete and verified, **stop and ask the user for permission to merge**.
   Present a brief summary of what was done on the branch before asking.

4. Only after the user explicitly approves, merge back into `main` and clean up:
   ```
   git checkout main
   git merge --no-ff feature/<short-description> -m "merge: <short-description>"
   git branch -d feature/<short-description>
   git push
   ```
