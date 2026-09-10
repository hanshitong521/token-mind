# Patch

```diff
--- a/src/main/java/OrderService.java
+++ b/src/main/java/OrderService.java
@@ -18,7 +18,9 @@ public class OrderService {
-    @Autowired private OrderMapper orderMapper;
+    private final OrderMapper orderMapper;
+    public OrderService(OrderMapper orderMapper) { this.orderMapper = orderMapper; }
```
