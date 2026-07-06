# @crabd/action

## 0.2.0

### Minor Changes

- a965d53: Adds rate limiting hanlder functionality and related settings.

  When a model gets rate limited, users can now configure fallback models and the specific timeouts and how many retries crab'd should attempt. The bot identity will also update the persistent comment with relevant information. See the [rate limiting docs](https://crabd.lou.gg/reference/rate-limiting) for more info.

### Patch Changes

- Updated dependencies [a965d53]
  - @crabd/config@0.2.0
  - @crabd/core@0.2.0

## 0.1.1

### Patch Changes

- 85296a0: Adds websearch and improves review output labeling
- Updated dependencies [85296a0]
  - @crabd/config@0.1.1
  - @crabd/core@0.1.1

## 0.1.0

### Minor Changes

- 800807e: Initial release

### Patch Changes

- Updated dependencies [800807e]
  - @crabd/config@0.1.0
  - @crabd/core@0.1.0
