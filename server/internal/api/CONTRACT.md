# 内部实现契约

包名 `api`。统一以标准 `net/http.ServeMux` 注册路由，保持原 URL、JSON 和 HTTP 状态码。修改共享接口后运行各业务模块回归测试。

共享接口如下（完整字段以源码为准）：

```go
type Row = map[string]any
type DBTX interface { Exec(string, ...any) (sql.Result,error); Query(string,...any)(*sql.Rows,error); QueryRow(string,...any)*sql.Row }
type Server struct { DB *sql.DB; Config config.Settings; Root string; Version string; Now func() time.Time; Mux *http.ServeMux }
type Context struct { S *Server; R *http.Request; W http.ResponseWriter; DB DBTX; Status int }
type Handler func(*Context)(any,error)
func(s *Server) Handle(pattern string,h Handler) // 已鉴权路由，pattern例如"POST /api/companies"
func(s *Server) Public(pattern string,h Handler)
func(c *Context) Body()(Row,error) // 最多1MiB JSON对象，number为json.Number
func(c *Context) Tx(fn Handler)(any,error) // BEGIN IMMEDIATE 独立连接、提交/回滚，传入新Context.DB
func(c *Context) ReadTx(fn Handler)(any,error) // 多次查询使用同一只读快照，不占写事务预留锁
func(c *Context) Timestamp()string // UTC ISO时间，使用S.Now
func All(db DBTX,q string,args ...any)([]Row,error) // 空集合 []，数字 int64
func One(db DBTX,q string,args ...any)(Row,error) // 无行 nil,nil
func Insert(db DBTX,q string,args ...any)(int64,error)
func Int(v any)(int64,bool) // json.Number/int64/int/int32/整值float64；拒绝bool、小数、溢出
func Str(v any)string // string或空串，不将数字隐式转字符串
func Fields(r Row,keys ...string)Row // 明确响应字段；缺失值null
func E(status int,detail,code string)*APIError
type APIError struct{ Status int; Detail,Code string; FieldErrors Row; CurrentRevision *int64; Headers map[string]string }
func Invalid(code,field,message string)*APIError
func Revision(row Row,expected any)error
func PositiveID(value string)(int64,error)
func CanonicalJSON(v any)([]byte,error) // Python sort_keys/ensure_ascii=False兼容默认空格
func RequestHash(v any)(string,error)
func IdempotencyKey(r *http.Request,required bool)(string,error) // UUID
func RestoreIdempotent(db DBTX,r *http.Request,key,hash string)(Row,error)
func SaveIdempotent(db DBTX,r *http.Request,key,hash string,response Row,status int,resource string,id int64,at string)error
func ProjectIdentity(code string)(string,error) // 安全文件名+NFC casefold
```

config.Settings 有 ConfigPath/DataDir/BackupDir/Host/SessionSecret string，Port/BackupIntervalHours/BackupRetentionDays/MaxDocumentUploadMB int，BackupEnabled bool。

模块入口包括 `RegisterProcurement`、`RegisterBusiness`、`RegisterDelivery`、`RegisterDocuments`、`RegisterSystem` 和 `RegisterUpdates`，由 `application.go` 统一注册。业务辅助函数按模块添加前缀，避免共享包内名称冲突。

附件共享函数位于 `attachments.go`：

```go
type Attachment struct { OriginalFilename,ContentType,SHA256,Path string; SizeBytes int64 }
type AttachmentBatch struct { Attachments []Attachment }
type ManagedDocument struct { Title,ManagedFilename string }
func ReadAttachmentBody(c *Context,invalidCode string)(Row,*AttachmentBatch,error)
func(b *AttachmentBatch) HashPayload(payload Row)Row
func(b *AttachmentBatch) Publish(c *Context,projectCode,category string,documents []ManagedDocument,notes any,timestamp string)([]int64,error)
func(b *AttachmentBatch) Close()error // defer总调用；c.Tx成功提交自动保留已发布文件，失败自动回收
func ManagedFilename(parts []any,originalFilename string,preserveLastParts int)string
func DocumentManagedFilename(projectCode,category,title,businessDate string,version int64,originalFilename string)string
func CompactISODate(value string)string
```

ReadAttachmentBody 对 JSON 返回空 AttachmentBatch，对 multipart 严格解析 payload + files，默认错误代码为传入 invalidCode，超大错误沿用模块自行转换。使用方法：`payload,batch,err:=ReadAttachmentBody(c,"..."); if err!=nil{return nil,err}; defer batch.Close(); return c.Tx(func(tx *Context)(any,error){ids,err:=batch.Publish(tx,...);...})`。Publish 通过 Context 的事务提交/回滚回调自动处理文件所有权。
