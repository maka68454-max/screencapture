import { Capture } from './capture';
import { CaptureStream } from './capture-stream';
import { LiveStreamPublisher } from './live-stream';
import './style.css';

const capture = new Capture();
capture.start();

const stream = new CaptureStream();
stream.start();

const liveStream = new LiveStreamPublisher();
liveStream.start();
