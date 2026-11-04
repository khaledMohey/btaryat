import { Module } from '@nestjs/common';
import { OldBatteriesController } from './oldbatteries.controller';
import { OldBatteriesService } from './oldbatteries.service';
import { SequenceService } from '../common/sequence.service';

@Module({
  controllers: [OldBatteriesController],
  providers: [OldBatteriesService, SequenceService],
})
export class OldBatteriesModule {}
