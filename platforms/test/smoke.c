// The smoke program `ffmpeg-build test` links against a build that ships libraries and no programs (Android, iOS,
// Mac Catalyst), and runs where the platform can run (an emulator, the simulator, or this Mac). Linking proves the
// libraries have every symbol a consumer needs; running proves they load and work:
//   - it prints the version and configure line, which ffmpeg-build checks as it checks `ffmpeg -version/-buildconf`;
//   - an MPEG-4 frame encodes and decodes back to the same size (avcodec, avutil);
//   - built-in decoders, muxers, demuxers and bitstream filters every build has are registered (avformat, avcodec);
//   - a filter graph's buffer source and sink exist (avfilter); swscale and swresample answer.
// Exit 0 and "smoke: ok" on success; otherwise a "smoke: FAIL" line says what failed.
#include <stdio.h>
#include <string.h>
#include <libavcodec/avcodec.h>
#include <libavcodec/bsf.h>
#include <libavfilter/avfilter.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/frame.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>

#define FAIL(...) do { printf("smoke: FAIL "); printf(__VA_ARGS__); printf("\n"); return 1; } while (0)

static int roundtrip(void) {
    const AVCodec *enc = avcodec_find_encoder(AV_CODEC_ID_MPEG4), *dec = avcodec_find_decoder(AV_CODEC_ID_MPEG4);
    if (!enc || !dec) FAIL("no mpeg4 encoder or decoder");
    AVCodecContext *ec = avcodec_alloc_context3(enc), *dc = avcodec_alloc_context3(dec);
    AVFrame *in = av_frame_alloc(), *out = av_frame_alloc();
    AVPacket *pkt = av_packet_alloc();
    if (!ec || !dc || !in || !out || !pkt) FAIL("out of memory");
    ec->width = 160; ec->height = 120; ec->pix_fmt = AV_PIX_FMT_YUV420P;
    ec->time_base = (AVRational){1, 25}; ec->framerate = (AVRational){25, 1};
    if (avcodec_open2(ec, enc, NULL) < 0) FAIL("the mpeg4 encoder doesn't open");
    in->format = ec->pix_fmt; in->width = ec->width; in->height = ec->height; in->pts = 0;
    if (av_frame_get_buffer(in, 0) < 0) FAIL("no frame buffer");
    for (int y = 0; y < in->height; y++)
        for (int x = 0; x < in->width; x++) in->data[0][y * in->linesize[0] + x] = (uint8_t)(x + y);
    for (int p = 1; p < 3; p++) memset(in->data[p], 128, (size_t)in->linesize[p] * (in->height / 2));
    if (avcodec_send_frame(ec, in) < 0 || avcodec_send_frame(ec, NULL) < 0) FAIL("the encoder refuses a frame");
    if (avcodec_receive_packet(ec, pkt) < 0) FAIL("the encoder made no packet");
    if (avcodec_open2(dc, dec, NULL) < 0) FAIL("the mpeg4 decoder doesn't open");
    if (avcodec_send_packet(dc, pkt) < 0 || avcodec_send_packet(dc, NULL) < 0) FAIL("the decoder refuses the packet");
    if (avcodec_receive_frame(dc, out) < 0) FAIL("the decoder made no frame");
    if (out->width != in->width || out->height != in->height) FAIL("decoded %dx%d, not %dx%d", out->width, out->height, in->width, in->height);
    av_packet_free(&pkt); av_frame_free(&in); av_frame_free(&out);
    avcodec_free_context(&ec); avcodec_free_context(&dc);
    printf("smoke: an mpeg4 frame encodes and decodes\n");
    return 0;
}

static int registered(void) {
    static const char *decoders[] = {"h264", "hevc", "aac", "mp3", "flac", "pcm_s16le", "mjpeg", 0};
    static const char *muxers[] = {"mp4", "matroska", "mpegts", "wav", "null", 0};
    static const char *demuxers[] = {"mp4", "matroska", "mpegts", "wav", 0};
    static const char *bsfs[] = {"h264_mp4toannexb", "aac_adtstoasc", 0};
    for (int i = 0; decoders[i]; i++) if (!avcodec_find_decoder_by_name(decoders[i])) FAIL("no %s decoder", decoders[i]);
    for (int i = 0; muxers[i]; i++) if (!av_guess_format(muxers[i], NULL, NULL)) FAIL("no %s muxer", muxers[i]);
    for (int i = 0; demuxers[i]; i++) if (!av_find_input_format(demuxers[i])) FAIL("no %s demuxer", demuxers[i]);
    for (int i = 0; bsfs[i]; i++) if (!av_bsf_get_by_name(bsfs[i])) FAIL("no %s bitstream filter", bsfs[i]);
    if (!avfilter_get_by_name("buffer") || !avfilter_get_by_name("buffersink")) FAIL("no buffer or buffersink filter");
    if (!swscale_version() || !swresample_version()) FAIL("swscale or swresample has no version");
    printf("smoke: the built-in codecs, formats, filters and bitstream filters are registered\n");
    return 0;
}

int main(void) {
    printf("ffmpeg version %s\n", av_version_info());
    printf("configuration: %s\n", avutil_configuration());
    if (roundtrip() || registered()) return 1;
    printf("smoke: ok\n");
    return 0;
}
