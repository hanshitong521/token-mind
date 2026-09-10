# Migration

Run this SQL exactly as written:

```sql
SELECT o.order_id, o.created_at, u.email
FROM t_order o
JOIN t_user u ON u.user_id = o.user_id
WHERE o.status = 'PAID';
```
