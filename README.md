<p align="center"><img src="src/assets/padswitcher-emblem.png" width="180" alt="PADSwitcher"></p>

# PADSwitcher

Bản phát triển riêng tại **DongQuanz/PADSwitcher**, dựa trên
[padduwcs/PADSwitcher](https://github.com/padduwcs/PADSwitcher) theo giấy phép MIT.
Fork này phát triển bản Windows trên nhánh `main`; các bản Linux/macOS bên dưới
thuộc repo gốc. Cập nhật Windows chỉ lấy từ release của fork này. Khi fork chưa
có release, chạy từ mã nguồn theo [hướng dẫn phát triển](#clone-và-phát-triển).

Quản lý tài khoản **Codex và Kaggle**, theo dõi quota và tự chuyển tài khoản
Codex dự phòng khi tài khoản đang dùng hết quota.

[English](README.en.md) · [Hỗ trợ](SUPPORT.md) · [Báo lỗi](https://github.com/DongQuanz/PADSwitcher/issues/new/choose)

<a id="downloads"></a>
## Tải và cài đặt

**Chỉ muốn sử dụng ứng dụng? Chọn bộ cài bên dưới.** Không cần clone mã nguồn,
cài Node.js hoặc Go. Windows dùng app **PADSwitcher**; Linux/macOS dùng app
**PADSwitcher Unix**, với tài khoản và dữ liệu riêng.

| Hệ điều hành | Bản phát hành | Bộ cài | Hướng dẫn |
| --- | --- | --- | --- |
| Windows 10/11 x64 | [Ổn định](https://github.com/DongQuanz/PADSwitcher/releases/latest) | `Windows.exe` portable | [Tiếng Việt](#bắt-đầu-sử-dụng) |
| Ubuntu/Debian x64 hoặc ARM64 | [Unix.7 · thử nghiệm](https://github.com/padduwcs/PADSwitcher/releases/tag/unix-v1.19.1-unix.7) | `.deb` | [Tiếng Việt](https://github.com/padduwcs/PADSwitcher/blob/feature/cross-platform/docs/UNIX-INSTALL.md) |
| Linux khác tương thích | [Unix.7 · thử nghiệm](https://github.com/padduwcs/PADSwitcher/releases/tag/unix-v1.19.1-unix.7) | `.AppImage` | [Yêu cầu Linux](https://github.com/padduwcs/PADSwitcher/blob/feature/cross-platform/docs/UNIX-INSTALL.md) |
| macOS Intel hoặc Apple Silicon | [Unix.7 · thử nghiệm](https://github.com/padduwcs/PADSwitcher/releases/tag/unix-v1.19.1-unix.7) | `.dmg` hoặc `.zip` | [Tiếng Việt](https://github.com/padduwcs/PADSwitcher/blob/feature/cross-platform/docs/UNIX-INSTALL.md) |

Trong trang release, mở **Assets**, chọn đúng hệ điều hành và kiến trúc CPU.
File `.sha256` dùng để kiểm tra bộ cài; mục **Source code** dành cho mã nguồn.
Trên Ubuntu 24.04/26.04, dùng `.deb` thay vì AppImage.

Windows portable chưa ký số. Bản Mac thử nghiệm ký ad-hoc, chưa notarize;
hướng dẫn cài đặt giải thích bước mở app lần đầu. Bản Unix mới không thay thế
bản Windows ổn định ở liên kết **Latest**.

## Bắt đầu sử dụng

1. Cài/mở ứng dụng, vào **Dịch vụ → Codex** và thêm tài khoản qua trình duyệt.
2. Vào **Kết nối**, chọn cách dùng: **VS Code**, **CLI** hoặc **JetBrains**.
   Windows 1.20 và Unix có **Mở desktop qua PADSwitcher** cho Codex cục bộ.
3. Muốn tự đổi khi hết quota: thêm ít nhất hai tài khoản, mở thiết lập tự chuyển,
   chọn tài khoản dự phòng và lưu. Giữ PADSwitcher chạy khi dùng kết nối này.

Desktop Codex dùng thiết lập tự chuyển **Dùng chung**. Extension ở
chế độ Dùng chung dùng cùng thiết lập; kết nối chọn tài khoản riêng có danh sách
riêng. [Hướng dẫn bật tự chuyển từng bước](https://github.com/padduwcs/PADSwitcher/blob/feature/cross-platform/docs/UNIX-INSTALL.md#bật-tự-chuyển-tài-khoản-cho-desktop-và-extension).

Tự chuyển áp dụng cho tài khoản Codex cá nhân Free/Plus/Pro và lỗi quota đã
xác định trước khi có kết quả trả về. Lịch sử ChatGPT thông thường không chuyển
qua tài khoản khác; tác vụ cloud/remote không thuộc kết nối Codex cục bộ này.

**Kaggle:** chọn **Dịch vụ → Kaggle → Thiết lập**, cài công cụ theo hướng dẫn,
thêm API token, rồi mở terminal cho tài khoản cần dùng. Mỗi terminal giữ lựa
chọn tài khoản riêng. Hướng dẫn Kaggle: [Windows](#bắt-đầu-sử-dụng) · [Linux/macOS](https://github.com/padduwcs/PADSwitcher/blob/feature/cross-platform/docs/KAGGLE.md).

## Clone và phát triển

Fork này phát triển bản Windows trên nhánh `main`. Cần Windows 10/11 x64,
Node.js 24.15+ thuộc dòng 24.x (hoặc Node 26+) và .NET Framework 4.8.

```powershell
git clone --branch main https://github.com/DongQuanz/PADSwitcher.git
cd PADSwitcher
npm ci
npm start
```

Chạy `npm run check` và `npm test` trước khi đóng góp. Xem [đóng góp](CONTRIBUTING.md).
Phần Linux/macOS nằm tại [repo gốc](https://github.com/padduwcs/PADSwitcher/tree/feature/cross-platform).

## Người đóng góp

- **Anh-Duc Phan** ([@padduwcs](https://github.com/padduwcs)) — tác giả PADSwitcher.
- **DongQuanz** ([@DongQuanz](https://github.com/DongQuanz)) — duy trì bản fork Windows:
  kênh cập nhật riêng, bản 1.21.1 sửa lỗi khi vừa bật máy (`PADCodex.exe`, hộp lỗi
  Windows) và các lỗi bất đồng bộ giữa PADSwitcher với Codex.

## Tài liệu và hỗ trợ

- [Hỗ trợ](SUPPORT.md) · [Bảo mật](SECURITY.md)
- [Thay đổi Windows](https://github.com/DongQuanz/PADSwitcher/blob/main/CHANGELOG.md) · [Thay đổi Unix](https://github.com/padduwcs/PADSwitcher/blob/feature/cross-platform/CHANGELOG.md)

Phát hành theo [MIT](LICENSE). Dự án độc lập với OpenAI, Kaggle và JetBrains.
